/**
 * Canned GitHub payloads for the demo. Shapes follow the real REST API closely
 * enough that an agent written against GitHub keeps working, no closer.
 */

export const PULL_REQUEST_NUMBER = 991;

export const paymentsRepo = {
  id: 62104,
  name: 'payments',
  full_name: 'acme/payments',
  private: true,
  owner: { login: 'acme', id: 9001, type: 'Organization' },
  html_url: 'https://github.com/acme/payments',
  description: 'Payment orchestration and webhook processing',
  default_branch: 'main',
  visibility: 'private',
  open_issues_count: 17,
  pushed_at: '2026-08-05T09:12:44Z',
};

/**
 * Readable with the very same credential as `payments`. The demo denies it at the
 * gateway, which is the whole point: the blast radius comes from policy, not from
 * what the token happens to be allowed to do.
 */
export const secretProjectRepo = {
  id: 62233,
  name: 'secret-project',
  full_name: 'acme/secret-project',
  private: true,
  owner: { login: 'acme', id: 9001, type: 'Organization' },
  html_url: 'https://github.com/acme/secret-project',
  description: 'Unreleased pricing engine',
  default_branch: 'main',
  visibility: 'private',
  open_issues_count: 3,
  pushed_at: '2026-08-07T16:31:02Z',
};

export const paymentsIssue423 = {
  id: 1904423,
  number: 423,
  state: 'open',
  title: 'Payment webhook retries duplicate charges',
  body: 'Stripe retries the webhook after our 502s and we charge the customer twice. The handler needs an idempotency key derived from the event id.',
  user: { login: 'dana-ops', id: 4412, type: 'User' },
  labels: [{ name: 'bug' }, { name: 'payments' }],
  comments: 4,
  html_url: 'https://github.com/acme/payments/issues/423',
  created_at: '2026-08-03T11:04:19Z',
  updated_at: '2026-08-06T08:47:55Z',
};

export function createdPullRequest(title: string) {
  return {
    id: 7710991,
    number: PULL_REQUEST_NUMBER,
    state: 'open',
    draft: false,
    title,
    html_url: `https://github.com/acme/payments/pull/${PULL_REQUEST_NUMBER}`,
    user: { login: 'agentgate-demo-agent', id: 5150, type: 'Bot' },
    created_at: '2026-08-10T10:00:00Z',
  };
}
