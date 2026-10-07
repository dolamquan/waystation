interface ApprovalReview {
  readonly risk_level: string;
  readonly user_authorization: string;
  readonly outcome: 'allow' | 'deny';
  readonly rationale: string;
}

/** Recognize the internal reviewer response, including summaries clipped by the event store. */
export function isApprovalReview(text: string): boolean {
  let review: Partial<ApprovalReview>;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    review = value;
  } catch {
    if (!text.endsWith('…')) return false;
    // Historical summaries use this field order and may end partway through the rationale.
    const header = /^\s*\{\s*"risk_level"\s*:\s*"([^"]+)"\s*,\s*"user_authorization"\s*:\s*"([^"]+)"\s*,\s*"outcome"\s*:\s*"(allow|deny)"\s*,\s*"rationale"\s*:\s*"/.exec(text);
    if (!header) return false;
    review = { risk_level: header[1], user_authorization: header[2], outcome: header[3] as 'allow' | 'deny', rationale: '' };
  }
  return ['low', 'medium', 'high', 'critical'].includes(review.risk_level ?? '')
    && ['low', 'medium', 'high', 'unknown'].includes(review.user_authorization ?? '')
    && (review.outcome === 'allow' || review.outcome === 'deny')
    && typeof review.rationale === 'string';
}
