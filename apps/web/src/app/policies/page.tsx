import Link from 'next/link';
import type { ReactElement } from 'react';
import { ActionChips } from '@/components/ActionChips';
import { EmptyState } from '@/components/EmptyState';
import { JsonBlock } from '@/components/JsonBlock';
import { ErrorPanel, Field, PageHeader, Panel } from '@/components/Panel';
import { StatusChip } from '@/components/StatusChip';
import { api, describeError } from '@/lib/api';
import { timeLeft } from '@/lib/format';
import { readPermissions } from '@/lib/mission-doc';
import type { Mission } from '@/lib/types';

/**
 * Which engine is evaluating.
 *
 * Read from this console's own environment, not from the gateway: the management API does not
 * report its engine, and inventing a value the gateway never sent would be the one lie a policy
 * screen must not tell. The page says where the value came from, so a mismatch between the two
 * services is visible rather than hidden behind a confident label.
 */
function configuredEngine(): string {
  return process.env.POLICY_ENGINE ?? 'builtin';
}

const ENGINES: Record<string, string> = {
  builtin:
    'Deterministic TypeScript in the gateway, applying the decision order over each mission document. No sidecar, fully unit-tested.',
  opa: 'Open Policy Agent, evaluating policies/agentgate.rego with the same decision order. The gateway posts it the identical policy input.',
};

export default async function PoliciesPage(): Promise<ReactElement> {
  const engine = configuredEngine();

  const header = (
    <PageHeader
      eyebrow="Decision rules"
      title="Policies"
      description="In this version, policy is mission-scoped: there is no global rule set. Each mission carries the permission and network documents the engine evaluates, and this page shows them read-only."
    />
  );

  let missions: Mission[];
  try {
    missions = await api.missions();
  } catch (error) {
    return (
      <>
        {header}
        <ErrorPanel title="The gateway did not answer" detail={describeError(error)} />
      </>
    );
  }

  const active = missions.filter((mission) => mission.status === 'active');
  const shown = active.length > 0 ? active : missions;

  return (
    <>
      {header}

      <Panel title="Engine">
        <div className="grid gap-5 px-5 py-4 sm:grid-cols-3">
          <Field label="Configured engine" mono>
            {engine}
          </Field>
          <div className="sm:col-span-2">
            <dt className="eyebrow">What it does</dt>
            <dd className="text-ink-muted mt-1 text-sm leading-relaxed">
              {ENGINES[engine] ?? 'An engine this console does not recognise.'}
            </dd>
          </div>
        </div>
        <p className="border-line text-ink-faint border-t px-5 py-3 text-xs leading-relaxed">
          Read from <code className="ident">POLICY_ENGINE</code> in this console&rsquo;s own
          environment. The management API does not report which engine the gateway booted with, so
          treat this as the deployment&rsquo;s intent rather than an observation of the gateway.
        </p>
      </Panel>

      <div className="mt-4">
        <Panel
          title="Decision order"
          description="The same ten steps for every request, whichever engine is running. The first one that matches ends it."
        >
          <ol className="text-ink-muted grid gap-x-8 gap-y-1.5 px-5 py-4 text-sm sm:grid-cols-2">
            {[
              'Invalid or expired agent token → deny',
              'Mission missing, expired or revoked → deny',
              'Limits exceeded → deny',
              'Network deny rule matches → deny',
              'No network allow rule matches → deny',
              'Route maps to no known action → deny',
              'Action is in denied_actions → deny',
              'Action needs approval → require approval, unless a valid grant is attached',
              'Action is in allowed_actions → allow',
              'Anything else → deny',
            ].map((step, index) => (
              <li key={step} className="flex gap-2.5">
                <span className="ident text-ink-faint w-4 shrink-0 text-right">{index + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </Panel>
      </div>

      <div className="mt-4">
        <Panel
          title={active.length > 0 ? 'Policy per live mission' : 'Policy per mission'}
          description="Each mission is its own policy. Open one to see its network rules, budget and usage."
        >
          {shown.length === 0 ? (
            <EmptyState
              title="There is no policy to show, because there is no mission"
              hint="POST /api/v1/missions"
            >
              Policies are attached to missions in this version — there is no global rule set to
              edit here, and this console never evaluates one. Issue a mission and its permission
              and network documents appear on this page exactly as the engine reads them.
            </EmptyState>
          ) : (
            <ul className="divide-line divide-y">
              {shown.map((mission) => {
                const permissions = readPermissions(mission.permissions);

                return (
                  <li key={mission.id} className="px-5 py-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <Link
                          href={`/missions/${mission.id}`}
                          className="text-ink hover:text-accent-ink text-sm font-medium underline-offset-4 hover:underline"
                        >
                          {mission.intent}
                        </Link>
                        <p className="ident text-ink-faint mt-1 text-xs">{mission.id}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <StatusChip status={mission.status} />
                        <span className="ident text-ink-faint text-xs">
                          {timeLeft(mission.expiresAt)}
                        </span>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-6 md:grid-cols-3">
                      <ActionChips
                        label="Denied"
                        note="Never forwarded."
                        actions={permissions.deniedActions}
                        tone="deny"
                      />
                      <ActionChips
                        label="Needs approval"
                        note="Stops for a human."
                        actions={permissions.approvalActions}
                        tone="review"
                      />
                      <ActionChips
                        label="Allowed"
                        note="Forwarded with a credential."
                        actions={permissions.allowedActions}
                        tone="allow"
                      />
                    </div>

                    <details className="group mt-4">
                      <summary className="text-ink-muted hover:text-ink cursor-pointer text-xs select-none">
                        Documents as the engine reads them
                      </summary>
                      <div className="mt-3 grid gap-3 lg:grid-cols-2">
                        <JsonBlock label="permissions" value={mission.permissions} />
                        <JsonBlock label="network" value={mission.network} />
                      </div>
                    </details>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
