import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';
import { DecisionBadge } from '@/components/DecisionBadge';
import { JsonBlock } from '@/components/JsonBlock';
import { ErrorPanel, Field, PageHeader, Panel } from '@/components/Panel';
import { api, describeError, GatewayError } from '@/lib/api';
import { absoluteTime, bytes } from '@/lib/format';
import { readSnapshot, refusalStage, type Slice } from '@/lib/snapshot';
import type { DecisionRecord } from '@/lib/types';

/** The formula, printed as a formula. This is the screen the whole product is about. */
const TERMS = ['MISSION', 'IDENTITY', 'RESOURCE', 'ACTION', 'DATA', 'ENVIRONMENT', 'CURRENT STATE'];

/** One field of one slice. A nested document is offered, not unfolded — depth on demand. */
function value(input: unknown): ReactElement {
  if (input === null || input === undefined) {
    return <span className="text-ink-faint">—</span>;
  }
  if (typeof input === 'object') {
    return (
      <details>
        <summary className="text-accent hover:text-accent-ink cursor-pointer text-xs select-none">
          {Array.isArray(input) ? `${input.length} entries` : 'document'}
        </summary>
        <div className="mt-2">
          <JsonBlock value={input} />
        </div>
      </details>
    );
  }

  return <span className="ident text-ink break-all">{String(input)}</span>;
}

function SliceCard({ slice }: { slice: Slice }): ReactElement {
  const entries = slice.value === null ? [] : Object.entries(slice.value);

  return (
    <div className="card px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-ink text-xs font-semibold tracking-[0.09em] uppercase">{slice.term}</h3>
        <p className="text-ink-faint max-w-md text-xs leading-snug">{slice.note}</p>
      </div>

      {entries.length === 0 ? (
        <p className="text-ink-faint mt-3 text-xs italic">
          the snapshot carried nothing under this term
        </p>
      ) : (
        <dl className="mt-3 grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
          {entries.map(([key, entry]) => (
            <div key={key} className="min-w-0">
              <dt className="eyebrow">{key}</dt>
              <dd className="mt-0.5 text-sm">{value(entry)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** The connector between two terms of the formula. */
function Plus(): ReactElement {
  return (
    <div aria-hidden="true" className="flex items-center gap-3 py-1.5 pl-5">
      <span className="border-line text-ink-faint grid size-5 place-items-center rounded-full border bg-surface text-xs leading-none">
        +
      </span>
      <span className="bg-line h-px flex-1" />
    </div>
  );
}

/** The step down from context to judgment, and from judgment to answer. */
function Arrow({ label }: { label: string }): ReactElement {
  return (
    <div className="flex flex-col items-center py-4">
      <span aria-hidden="true" className="bg-line-strong h-8 w-px" />
      <span className="eyebrow -mt-1 bg-canvas px-2">{label}</span>
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className="text-line-strong mt-1 size-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M8 2v11M4 9.5 8 13.5l4-4" />
      </svg>
    </div>
  );
}

const VERDICT_TONE: Record<string, string> = {
  ALLOW: 'border-allow-line bg-allow-soft',
  DENY: 'border-deny-line bg-deny-soft',
  REQUIRE_APPROVAL: 'border-review-line bg-review-soft',
  ERROR: 'border-fault-line bg-fault-soft',
};

export default async function DecisionPage({
  params,
}: {
  params: Promise<{ requestId: string }>;
}): Promise<ReactElement> {
  const { requestId } = await params;

  let record: DecisionRecord;
  try {
    record = await api.decision(requestId);
  } catch (error) {
    if (error instanceof GatewayError && error.status === 404) {
      notFound();
    }

    return (
      <>
        <PageHeader eyebrow="Runtime decision" title={requestId} />
        <ErrorPanel title="The decision could not be read" detail={describeError(error)} />
      </>
    );
  }

  const snapshot = readSnapshot(record.policyInputSnapshot);
  const stage = snapshot === null ? refusalStage(record.reason, record.matchedPolicy) : null;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        eyebrow="Runtime decision"
        title={record.requestId}
        description="Everything the gateway knew, and what it concluded. This is the whole judgment — nothing below was reconstructed after the fact."
        actions={<DecisionBadge decision={record.decision} />}
      />

      <p className="ident text-ink-faint mb-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.6875rem]">
        {TERMS.map((term, index) => (
          <span key={term} className="flex items-center gap-2">
            {index === 0 ? null : <span className="text-line-strong">+</span>}
            {term}
          </span>
        ))}
        <span className="text-line-strong">→</span>
        <span className="text-ink font-semibold">DECISION</span>
      </p>

      {snapshot === null ? (
        <div className="card border-fault-line bg-fault-soft px-5 py-5">
          <h3 className="text-ink text-xs font-semibold tracking-[0.09em] uppercase">
            No policy was reached
          </h3>
          <p className="text-ink-muted mt-2 text-sm leading-relaxed">
            This request was refused by the pipeline before a policy could be evaluated, so there is
            no context snapshot to show. That is a fact about the request, not a gap in the record:
            the decision was made by the gateway&rsquo;s own preconditions rather than by a rule.
          </p>
          {stage === null ? null : <p className="text-ink mt-3 text-sm leading-relaxed">{stage}</p>}
          <p className="border-fault-line text-ink-muted mt-4 border-t pt-3 text-xs leading-relaxed">
            Recorded reason: <span className="ident text-ink">{record.reason}</span>
          </p>
        </div>
      ) : (
        <div className="rise">
          {snapshot.slices.map((slice, index) => (
            <div key={slice.term}>
              {index === 0 ? null : <Plus />}
              <SliceCard slice={slice} />
              {slice.term === 'Resource' && snapshot.network.value !== null ? (
                <>
                  <Plus />
                  <SliceCard slice={snapshot.network} />
                </>
              ) : null}
            </div>
          ))}

          {snapshot.unknownKeys.length === 0 ? null : (
            <div className="mt-3">
              <JsonBlock
                label={`terms this console has no card for: ${snapshot.unknownKeys.join(', ')}`}
                value={Object.fromEntries(
                  snapshot.unknownKeys.map((key) => [
                    key,
                    (record.policyInputSnapshot as Record<string, unknown>)[key],
                  ]),
                )}
              />
            </div>
          )}
        </div>
      )}

      <Arrow label="evaluated by" />

      <div className={`card border px-5 py-4 ${VERDICT_TONE[record.decision] ?? ''}`}>
        <h3 className="text-ink text-xs font-semibold tracking-[0.09em] uppercase">
          Policy decision
        </h3>
        <dl className="mt-3 grid gap-4 sm:grid-cols-2">
          <Field label="Matched policy" mono>
            {record.matchedPolicy ?? <span className="text-ink-faint">none — default deny</span>}
          </Field>
          <Field label="Reason">{record.reason}</Field>
        </dl>
      </div>

      <Arrow label="answer" />

      <div className="flex justify-center">
        <DecisionBadge decision={record.decision} size="lg" />
      </div>

      <div className="mt-10">
        <Panel
          title="Request"
          description="What was attempted, and what the gateway did with it. No header, body or credential is recorded — only metadata about them."
        >
          <dl className="grid grid-cols-2 gap-5 px-5 py-4 sm:grid-cols-4">
            <Field label="When">{absoluteTime(record.timestamp)}</Field>
            <Field label="Latency" mono>
              {record.latencyMs} ms
            </Field>
            <Field label="Method" mono>
              {record.method ?? '—'}
            </Field>
            {/*
              The status the *gateway* answered with, which is only the upstream's own status on
              an ALLOW. Every other outcome is refused before anything is forwarded, so a DENY
              here reads 403 and a REQUIRE_APPROVAL reads 202 — neither of which any upstream
              ever sent. Labelling those "upstream status" invents a third party that was never
              contacted, on the one screen whose whole job is to say what actually happened.
            */}
            <Field label="Answered" mono>
              {record.httpStatus ?? '—'}
            </Field>

            <div className="col-span-2 min-w-0 sm:col-span-4">
              <dt className="eyebrow">Destination</dt>
              <dd className="ident text-ink mt-1 text-sm break-all">
                {record.destHost === null ? '—' : `${record.destHost}${record.destPath ?? ''}`}
              </dd>
            </div>

            <Field label="Agent" mono>
              {record.agentId === null ? (
                '—'
              ) : (
                <Link
                  href={`/agents/${record.agentId}`}
                  className="text-accent-ink underline-offset-4 hover:underline"
                >
                  {record.agentId}
                </Link>
              )}
            </Field>
            <Field label="Principal" mono>
              {record.principalId ?? '—'}
            </Field>
            <Field label="Mission" mono>
              {record.missionId === null ? (
                '—'
              ) : (
                <Link
                  href={`/missions/${record.missionId}`}
                  className="text-accent-ink underline-offset-4 hover:underline"
                >
                  {record.missionId}
                </Link>
              )}
            </Field>
            <Field label="Approval" mono>
              {record.approvalId === null ? (
                <span className="text-ink-faint">none</span>
              ) : (
                <Link
                  href="/approvals?tab=history"
                  className="text-accent-ink underline-offset-4 hover:underline"
                >
                  {record.approvalId}
                </Link>
              )}
            </Field>

            <Field label="Body size" mono>
              {record.bodySize === null ? '—' : bytes(record.bodySize)}
            </Field>
            <Field label="Content type" mono>
              {record.contentType ?? '—'}
            </Field>
            <div className="col-span-2 min-w-0">
              <dt className="eyebrow">Body hash</dt>
              <dd className="ident text-ink-muted mt-1 text-xs break-all">
                {record.bodyHash ?? '—'}
              </dd>
            </div>
          </dl>
        </Panel>
      </div>
    </div>
  );
}
