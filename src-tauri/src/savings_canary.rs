//! Zero-savings canary.
//!
//! The 2026-08-21 Codex CLI 0.149.0 regression (tools moved out of the
//! top-level `tools` array into `additional_tools` input items) ran 7+ peak
//! hours before a human spotted it on the admin page. Nothing errored:
//! requests forwarded and streamed normally, they just compressed to exactly
//! zero. Every alarm we had was error-based or fleet-aggregated, and the
//! server-side per-client rate canary that looks like the obvious answer
//! cannot see it - codex is almost never a user's only client, so its
//! dominant-client cohort was n=1 on the day of the incident.
//!
//! The signature is local and per-request: a large request that ran through
//! the compression pipeline and saved nothing. This module reads it off the
//! `/transformations/feed` batch `run_activity_observation` already polls, and
//! reports once per process to Sentry, where events aggregate across the
//! fleet on a fixed fingerprint. One machine reporting is a lead; a hundred
//! is a graph.
//!
//! `detect_basis_violation` is the second canary here, for the opposite
//! failure: savings that are too LARGE to be true. See its banner.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::Value;

use crate::models::TransformationFeedEvent;

/// Requests below this are too small to draw a conclusion from - a short turn
/// with nothing compressible legitimately saves zero.
const MIN_INPUT_TOKENS: u64 = 10_000;
/// Qualifying requests needed before the ratio means anything. The observer
/// pulls 150 events per pass, so a busy machine clears this easily and a
/// barely-used one stays quiet instead of paging on three samples.
const MIN_SAMPLE: usize = 20;
/// Healthy traffic scatters; a wire-format change zeroes essentially all of
/// it. Anything short of near-total is noise, not a regression.
const ZERO_RATIO: f64 = 0.9;

/// One report per process. A wedged client produces the same finding on every
/// observer pass, and the point is to learn that it happened, not how often.
static REPORTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, PartialEq)]
pub struct Anomaly {
    /// Large, compression-eligible requests examined.
    pub sample: usize,
    /// How many of those saved nothing.
    pub zero: usize,
    /// Distinct output-shaper strata seen on the zero-saved requests. The
    /// `|notools` suffix is what named the Codex regression.
    pub strata: Vec<String>,
    /// Distinct `provider/model` pairs, to point at which client broke.
    pub models: Vec<String>,
    /// Distinct transform families that ran on the zero-saved requests, with
    /// per-request parameters trimmed off. This is the discriminator the first
    /// ten reports lacked: a wire-format regression leaves the router with
    /// nothing to match (`router:noop` alone next to the output shaper), while
    /// a compressor that ran and returned nothing shows its real stages. Every
    /// report so far spanned every provider at once, which no single client's
    /// wire format can explain -- the transforms say which of the two it was.
    pub transforms: Vec<String>,
}

/// Pick out the anomaly, or `None` when the batch looks healthy or is too
/// thin to judge. Pure: `observe` owns the reporting side effects.
pub fn detect(events: &[TransformationFeedEvent]) -> Option<Anomaly> {
    // An empty transform list means the pipeline never ran (bypass header,
    // optimize disabled, unlicensed). Those save zero by design and must not
    // page - only requests that were actually compressed count.
    let considered: Vec<&TransformationFeedEvent> = events
        .iter()
        .filter(|e| {
            !e.transforms_applied.is_empty()
                && e.input_tokens_original.unwrap_or(0) >= MIN_INPUT_TOKENS
        })
        .collect();

    if considered.len() < MIN_SAMPLE {
        return None;
    }

    let zeroed: Vec<&&TransformationFeedEvent> = considered
        .iter()
        .filter(|e| e.tokens_saved.unwrap_or(0) <= 0)
        .collect();

    if (zeroed.len() as f64) < considered.len() as f64 * ZERO_RATIO {
        return None;
    }

    // BTreeSet: deduped and ordered, so the Sentry extras are stable across
    // machines instead of reshuffling per batch.
    let mut strata = BTreeSet::new();
    let mut models = BTreeSet::new();
    let mut transforms = BTreeSet::new();
    for event in &zeroed {
        for transform in &event.transforms_applied {
            if let Some(stratum) = transform.strip_prefix("output_shaper:stratum:") {
                strata.insert(stratum.to_string());
                continue;
            }
            // First two segments only: `router:tool_search_deferral:9tools:
            // 14341tok` carries per-request counts that would make every
            // machine's set unique and the fleet view unreadable.
            transforms.insert(
                transform
                    .split(':')
                    .take(2)
                    .collect::<Vec<&str>>()
                    .join(":"),
            );
        }
        let provider = event.provider.as_deref().unwrap_or("?");
        let model = event.model.as_deref().unwrap_or("?");
        models.insert(format!("{provider}/{model}"));
    }

    Some(Anomaly {
        sample: considered.len(),
        zero: zeroed.len(),
        strata: strata.into_iter().take(5).collect(),
        models: models.into_iter().take(5).collect(),
        transforms: transforms.into_iter().take(6).collect(),
    })
}

/// Report a detected anomaly to Sentry, at most once per process.
pub fn observe(events: &[TransformationFeedEvent]) {
    let Some(anomaly) = detect(events) else {
        return;
    };
    if REPORTED.swap(true, Ordering::AcqRel) {
        return;
    }

    let strata = anomaly.strata.join(", ");
    let models = anomaly.models.join(", ");
    let transforms = anomaly.transforms.join(", ");
    // Fixed fingerprint: every affected machine lands in one issue, so the
    // event count is the blast radius. Counts stay out of it deliberately.
    let fingerprint: [&str; 1] = ["zero_savings_canary"];
    sentry::with_scope(
        |scope| {
            scope.set_tag("flow", "zero_savings_canary");
            scope.set_extra("sample", (anomaly.sample as u64).into());
            scope.set_extra("zero_saved", (anomaly.zero as u64).into());
            scope.set_extra("min_input_tokens", MIN_INPUT_TOKENS.into());
            scope.set_extra("strata", strata.clone().into());
            scope.set_extra("models", models.clone().into());
            scope.set_extra("transforms", transforms.clone().into());
            scope.set_fingerprint(Some(fingerprint.as_slice()));
        },
        || {
            sentry::capture_message(
                &format!(
                    "zero_savings_canary: {}/{} large requests compressed to nothing \
                     (models: {models}; strata: {strata}; transforms: {transforms})",
                    anomaly.zero, anomaly.sample
                ),
                sentry::Level::Warning,
            );
        },
    );
    log::warn!(
        "zero-savings canary: {}/{} requests over {MIN_INPUT_TOKENS} tokens saved nothing \
         (models: {models}; strata: {strata}; transforms: {transforms})",
        anomaly.zero,
        anomaly.sample
    );
}

// ── Savings-basis canary ─────────────────────────────────────────────────
//
// Every input-savings percentage the app shows divides compression savings by
// the new input those savings came out of (the INVARIANT banner on
// `parse_headroom_stats_from_json` in state.rs). That only means anything
// while the numerator is a SUBSET of the denominator. Savings taken off
// content that never entered as new input have nothing to divide by, so they
// push the rate toward 100% instead of measuring anything.
//
// It stopped holding on the OpenAI `/v1/responses` path. Codex re-sends the
// whole transcript every turn and the router recompresses all of it, so the
// same removed history is booked again on every turn while the denominator
// counts only what newly reached the provider. Measured 2026-09-08 across one
// machine's retained proxy logs: gpt/codex models reported 8.10M compression
// savings against 3.90M new input (2.1x, an impossible share, displayed as
// 67.5%), where Claude reported 4.18M against 43.3M -- its frozen cached
// prefix keeps removals inside new content, which is why its rate is honest.
// The fleet reads the same: codex-dominant user-days at 26.3%, claude-code at
// 4.0%.
//
// Repairing the numerator is upstream work in the router, which is the only
// layer that knows whether a removal is first-time or a re-run of one it
// already counted. This is the tripwire for the class: savings that outrun
// the new input they are divided by cannot mean what the label says, and we
// want to know which machines and how many.
//
// ponytail: machine-level, not per-provider. `/stats` breaks new input out by
// provider but never breaks savings out, so a mixed machine whose codex slice
// is inflated can still average under the threshold and stay quiet -- it fires
// on the codex-dominant machines, which is where the displayed number is most
// wrong (71 users / 150 user-days in the 21 days to 2026-09-08). Make it
// per-provider if and when a wheel reports savings by provider.

/// New input below this is too little to judge -- a freshly started backend
/// has a cold prefix cache, where savings legitimately sit close to the whole
/// (uncached) payload.
const BASIS_MIN_NEW_INPUT: u64 = 100_000;
/// Savings are counted on Headroom's tokenizer, new input on the provider's,
/// so the two scales disagree by a few percent even when the basis is sound.
/// Only a numerator that OUTRUNS its denominator is structurally impossible.
const BASIS_MAX_RATIO: f64 = 1.2;

/// One report per process, same reasoning as the zero-savings canary: this
/// re-detects on every `/stats` poll and the point is that it happened.
static BASIS_REPORTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, PartialEq)]
pub struct BasisViolation {
    /// Compression-only savings (`tokens.saved` less tool-schema deferral,
    /// which rides the cached prefix and is excluded from the rate too).
    pub compression_saved: u64,
    /// `prefix_cache` new input: cache writes plus uncached input.
    pub new_input: u64,
    /// `compression_saved / new_input`. Anything above 1.0 is impossible.
    pub ratio: f64,
    /// Each provider's share of new input, biggest first ("openai:82%").
    /// Savings are not broken out per provider anywhere in `/stats`, so this
    /// is what points triage at the responsible path.
    pub providers: Vec<String>,
}

fn u64_at(root: &Value, path: &[&str]) -> Option<u64> {
    let mut current = root;
    for segment in path {
        current = current.get(*segment)?;
    }
    current.as_u64()
}

/// Read the violation off a `/stats` body, or `None` when the basis holds or
/// the payload cannot answer. Pure: `observe_basis` owns the reporting.
pub fn detect_basis_violation(stats_body: &str) -> Option<BasisViolation> {
    let root: Value = serde_json::from_str(stats_body).ok()?;

    // Absent `prefix_cache.totals` means the backend reports no cache
    // dimension at all; the displayed rate falls back to forwarded tokens
    // there, which is a different (and bounded) basis. Nothing to check.
    let totals = root.get("prefix_cache")?.get("totals")?;
    let new_input = totals.get("cache_write_tokens").and_then(Value::as_u64)?
        + totals
            .get("uncached_input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
    if new_input < BASIS_MIN_NEW_INPUT {
        return None;
    }

    // Mirror the displayed numerator exactly, including the tool-schema
    // subtraction -- a canary on a different figure than the one on screen
    // would fire on the wrong machines.
    let saved = u64_at(&root, &["tokens", "saved"])?;
    let tool_schema = u64_at(
        &root,
        &["summary", "compression", "tool_schema_tokens_saved"],
    )
    .or_else(|| {
        u64_at(
            &root,
            &["savings", "by_layer", "tool_search", "tokens_saved"],
        )
    })
    .unwrap_or(0);
    let compression_saved = saved.saturating_sub(tool_schema);

    let ratio = compression_saved as f64 / new_input as f64;
    if ratio <= BASIS_MAX_RATIO {
        return None;
    }

    let mut providers: Vec<(u64, String)> = root
        .get("prefix_cache")
        .and_then(|cache| cache.get("by_provider"))
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .map(|(name, stats)| {
                    let share = stats
                        .get("cache_write_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                        + stats
                            .get("uncached_input_tokens")
                            .and_then(Value::as_u64)
                            .unwrap_or(0);
                    (share, name.clone())
                })
                .collect()
        })
        .unwrap_or_default();
    providers.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));

    Some(BasisViolation {
        compression_saved,
        new_input,
        ratio,
        providers: providers
            .into_iter()
            .take(3)
            .map(|(share, name)| format!("{name}:{}%", share * 100 / new_input.max(1)))
            .collect(),
    })
}

/// Report a basis violation to Sentry, at most once per process.
pub fn observe_basis(stats_body: &str) {
    let Some(violation) = detect_basis_violation(stats_body) else {
        return;
    };
    if BASIS_REPORTED.swap(true, Ordering::AcqRel) {
        return;
    }

    let providers = violation.providers.join(", ");
    // Fixed fingerprint, like the zero-savings canary: the fleet-wide event
    // count is the blast radius, and the ratio must not fragment the group.
    let fingerprint: [&str; 1] = ["savings_basis_canary"];
    sentry::with_scope(
        |scope| {
            scope.set_tag("flow", "savings_basis_canary");
            scope.set_extra("compression_saved", violation.compression_saved.into());
            scope.set_extra("new_input", violation.new_input.into());
            scope.set_extra("ratio", format!("{:.2}", violation.ratio).into());
            scope.set_extra("new_input_by_provider", providers.clone().into());
            scope.set_fingerprint(Some(fingerprint.as_slice()));
        },
        || {
            sentry::capture_message(
                &format!(
                    "savings_basis_canary: compression savings are {:.2}x the new input they \
                     are divided by (new input: {providers})",
                    violation.ratio
                ),
                sentry::Level::Warning,
            );
        },
    );
    log::warn!(
        "savings-basis canary: {} compression tokens saved against {} new input ({:.2}x); \
         the displayed input-savings rate is on a broken basis (new input: {providers})",
        violation.compression_saved,
        violation.new_input,
        violation.ratio
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(input_tokens: u64, saved: i64, transforms: &[&str]) -> TransformationFeedEvent {
        TransformationFeedEvent {
            request_id: None,
            timestamp: None,
            provider: Some("openai".to_string()),
            model: Some("gpt-5.6-sol".to_string()),
            input_tokens_original: Some(input_tokens),
            input_tokens_optimized: Some(input_tokens.saturating_sub(saved.max(0) as u64)),
            tokens_saved: Some(saved),
            savings_percent: None,
            transforms_applied: transforms.iter().map(|t| t.to_string()).collect(),
            workspace: None,
            turn_id: None,
            request_messages: None,
            compressed_messages: None,
        }
    }

    /// The Codex 0.149.0 shape: compression ran, classified `notools`, saved 0.
    fn zeroed_codex_batch(count: usize) -> Vec<TransformationFeedEvent> {
        (0..count)
            .map(|_| {
                event(
                    40_000,
                    0,
                    &[
                        "output_shaper:stratum:gpt|new_user_ask|m|notools",
                        "output_shaper:verbosity:L2",
                    ],
                )
            })
            .collect()
    }

    #[test]
    fn detects_a_fleet_of_large_requests_saving_nothing() {
        let anomaly = detect(&zeroed_codex_batch(MIN_SAMPLE)).expect("anomaly");
        assert_eq!(anomaly.sample, MIN_SAMPLE);
        assert_eq!(anomaly.zero, MIN_SAMPLE);
        assert_eq!(anomaly.strata, vec!["gpt|new_user_ask|m|notools"]);
        assert_eq!(anomaly.models, vec!["openai/gpt-5.6-sol"]);
        assert_eq!(anomaly.transforms, vec!["output_shaper:verbosity"]);
    }

    /// The two shapes the first ten reports could not be told apart by: a
    /// router that matched nothing, versus stages that ran and returned zero.
    /// Per-request parameters are trimmed so the sets collapse across machines.
    #[test]
    fn names_the_transform_families_behind_the_zeroes() {
        let batch: Vec<_> = (0..MIN_SAMPLE)
            .map(|_| {
                event(
                    40_000,
                    0,
                    &[
                        "router:noop",
                        "router:tool_search_deferral:9tools:14341tok",
                        "output_shaper:stratum:gpt|new_user_ask|m|notools",
                    ],
                )
            })
            .collect();
        assert_eq!(
            detect(&batch).expect("anomaly").transforms,
            vec!["router:noop", "router:tool_search_deferral"]
        );
    }

    #[test]
    fn stays_quiet_below_the_sample_floor() {
        assert!(detect(&zeroed_codex_batch(MIN_SAMPLE - 1)).is_none());
    }

    #[test]
    fn stays_quiet_when_compression_is_working() {
        let healthy: Vec<_> = (0..MIN_SAMPLE * 2)
            .map(|_| event(40_000, 608, &["openai:responses:tool_schema_compaction"]))
            .collect();
        assert!(detect(&healthy).is_none());
    }

    /// Passthrough (bypass header, optimize off, unlicensed) saves zero by
    /// design and must never page: the pipeline never ran, so no transforms.
    #[test]
    fn ignores_passthrough_requests() {
        let passthrough: Vec<_> = (0..MIN_SAMPLE * 2).map(|_| event(40_000, 0, &[])).collect();
        assert!(detect(&passthrough).is_none());
    }

    /// Small turns legitimately have nothing to compress.
    #[test]
    fn ignores_small_requests() {
        let small: Vec<_> = (0..MIN_SAMPLE * 2)
            .map(|_| event(MIN_INPUT_TOKENS - 1, 0, &["output_shaper:verbosity:L2"]))
            .collect();
        assert!(detect(&small).is_none());
    }

    /// A minority of zero-saved requests is ordinary scatter, not a break.
    #[test]
    fn tolerates_a_minority_of_zero_saved_requests() {
        let mut mixed = zeroed_codex_batch(4);
        mixed.extend(
            (0..16).map(|_| event(40_000, 900, &["openai:responses:tool_schema_compaction"])),
        );
        assert!(detect(&mixed).is_none());
    }

    /// Missing `tokens_saved` (older proxy, or an outcome that never recorded
    /// one) reads as zero rather than being silently dropped from the count.
    #[test]
    fn treats_absent_tokens_saved_as_zero() {
        let mut batch = zeroed_codex_batch(MIN_SAMPLE);
        for entry in &mut batch {
            entry.tokens_saved = None;
        }
        assert_eq!(detect(&batch).expect("anomaly").zero, MIN_SAMPLE);
    }

    #[test]
    fn observe_reports_at_most_once_per_process() {
        // The static is process-wide, so this asserts the swap contract
        // directly rather than fighting the other tests over Sentry state.
        assert!(!REPORTED.swap(true, Ordering::AcqRel));
        assert!(REPORTED.swap(true, Ordering::AcqRel));
        REPORTED.store(false, Ordering::Release);
    }

    /// `/stats` cut down to the fields the basis canary reads.
    fn stats_body(saved: u64, tool_schema: u64, providers: &[(&str, u64, u64)]) -> String {
        let by_provider: Vec<String> = providers
            .iter()
            .map(|(name, write, uncached)| {
                format!(
                    r#""{name}": {{"cache_write_tokens": {write}, "uncached_input_tokens": {uncached}}}"#
                )
            })
            .collect();
        let write: u64 = providers.iter().map(|(_, w, _)| w).sum();
        let uncached: u64 = providers.iter().map(|(_, _, u)| u).sum();
        format!(
            r#"{{
                "tokens": {{"saved": {saved}}},
                "summary": {{"compression": {{"tool_schema_tokens_saved": {tool_schema}}}}},
                "prefix_cache": {{
                    "totals": {{
                        "cache_write_tokens": {write},
                        "uncached_input_tokens": {uncached}
                    }},
                    "by_provider": {{{}}}
                }}
            }}"#,
            by_provider.join(", ")
        )
    }

    /// The measured 2026-09-08 codex shape: compression savings run at 2.1x
    /// the new input they are divided by, which no share of new content can.
    #[test]
    fn detects_savings_that_outrun_their_own_denominator() {
        let violation = detect_basis_violation(&stats_body(
            8_100_000,
            0,
            &[("openai", 0, 3_900_000), ("anthropic", 0, 100_000)],
        ))
        .expect("violation");
        assert_eq!(violation.compression_saved, 8_100_000);
        assert_eq!(violation.new_input, 4_000_000);
        assert!(
            (violation.ratio - 2.025).abs() < 1e-9,
            "{}",
            violation.ratio
        );
        // Savings are not split per provider anywhere in `/stats`, so the new
        // input mix is what names the path to look at.
        assert_eq!(violation.providers, vec!["openai:97%", "anthropic:2%"]);
    }

    /// The Claude shape from the same machine and the same hour: removals stay
    /// inside new content because the cached prefix is frozen.
    #[test]
    fn stays_quiet_when_savings_come_out_of_new_input() {
        assert!(detect_basis_violation(&stats_body(
            4_180_000,
            0,
            &[("anthropic", 20_000_000, 23_300_000)]
        ))
        .is_none());
    }

    /// Tool-schema deferral rides the cached prefix and is excluded from the
    /// displayed rate; counting it here would fire on tool-heavy Claude
    /// sessions, where the basis is sound.
    #[test]
    fn excludes_tool_schema_deferral_from_the_numerator() {
        // 3.9M all-layers against 300k new input is 13x -- but 3.7M of it is
        // deferral, and the 200k that is compression fits inside new input.
        assert!(detect_basis_violation(&stats_body(
            3_900_000,
            3_700_000,
            &[("anthropic", 100_000, 200_000)]
        ))
        .is_none());
    }

    /// A cold prefix cache legitimately puts savings near the whole payload.
    #[test]
    fn stays_quiet_below_the_new_input_floor() {
        assert!(detect_basis_violation(&stats_body(
            BASIS_MIN_NEW_INPUT * 5,
            0,
            &[("openai", 0, BASIS_MIN_NEW_INPUT - 1)]
        ))
        .is_none());
    }

    /// Tokenizer scale disagreement (local numerator, provider denominator) is
    /// not a basis break.
    #[test]
    fn tolerates_tokenizer_scale_disagreement() {
        assert!(
            detect_basis_violation(&stats_body(1_100_000, 0, &[("openai", 0, 1_000_000)]))
                .is_none()
        );
    }

    /// No `prefix_cache.totals` means the rate is on the forwarded-token
    /// basis, which is bounded by construction. Nothing to say.
    #[test]
    fn ignores_backends_that_report_no_cache_dimension() {
        assert!(detect_basis_violation(r#"{"tokens": {"saved": 9000000}}"#).is_none());
    }

    #[test]
    fn observe_basis_reports_at_most_once_per_process() {
        assert!(!BASIS_REPORTED.swap(true, Ordering::AcqRel));
        assert!(BASIS_REPORTED.swap(true, Ordering::AcqRel));
        BASIS_REPORTED.store(false, Ordering::Release);
    }
}
