import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';
import { ActionButton } from '@/components/ActionButton';
import { ActionChips } from '@/components/ActionChips';
import { EmptyState } from '@/components/EmptyState';
import { JsonBlock } from '@/components/JsonBlock';
import { MintTokenButton } from '@/components/MintTokenButton';
import { ErrorPanel, Field, PageHeader, Panel } from '@/components/Panel';
import { StatusChip } from '@/components/StatusChip';
import { UsageBar } from '@/components/UsageBar';
import { api, describeError, GatewayError } from '@/lib/api';
import { absoluteTime, bytes, count, timeLeft } from '@/lib/format';
import { readLimits, readNetwork, readPermissions, type NetworkRule } from '@/lib/mission-doc';
import type { MissionDetail } from '@/lib/types';

function rulesTable(title: string, note: string, rules: NetworkRule[]): ReactElement {
  return (
    <div>
      <div className="eyebrow">{title}</div>
      <p className="text-ink-faint mt-1 text-xs leading-snug">{note}</p>
      {rules.length === 0 ? (
        <p className="text-ink-faint mt-2.5 text-xs italic">no rule</p>
      ) : (
        <table className="mt-2.5 w-full border-collapse text-left">
          <thead>
            <tr className="border-line border-b">
              <th scope="col" className="eyebrow py-1.5 pr-3">
                Host
              </th>
              <th scope="col" className="eyebrow py-1.5 pr-3">
                Path
              </th>
              <th scope="col" className="eyebrow py-1.5">
                Methods
              </th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule, index) => (
              <tr
                key={`${rule.host}-${rule.path ?? ''}-${index}`}
                className="border-line border-b last:border-b-0"
              >
                <td className="ident py-2 pr-3">{rule.host}</td>
                <td className="ident text-ink-muted py-2 pr-3">{rule.path ?? '(any path)'}</td>
                <td className="ident text-ink-muted py-2">
                  {rule.methods === null || rule.methods.length === 0
                    ? '(any method)'
                    : rule.methods.join(' · ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default async function MissionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<ReactElement> {
  const { id } = await params;

  let mission: MissionDetail;
  try {
    mission = await api.mission(id);
  } catch (error) {
    if (error instanceof GatewayError && error.status === 404) {
      notFound();
    }

    return (
      <>
        <PageHeader eyebrow="Mission" title={id} />
        <ErrorPanel title="The gateway did not answer" detail={describeError(error)} />
      </>
    );
  }

  const permissions = readPermissions(mission.permissions);
  const network = readNetwork(mission.network);
  const limits = readLimits(mission.limits);
  const live = mission.status === 'active' && new Date(mission.expiresAt).getTime() > Date.now();

  return (
    <>
      <PageHeader
        eyebrow="Mission"
        title={mission.id}
        description={mission.intent}
        actions={
          <>
            <MintTokenButton missionId={mission.id} />
            <ActionButton
              endpoint={`/api/missions/${encodeURIComponent(mission.id)}/expire`}
              label="Expire mission"
              pendingLabel="Expiring…"
              tone="deny"
              confirm={{
                title: 'Expire this mission?',
                body: (
                  <>
                    Every request the agent makes from now on is denied, including one already in
                    flight with a valid token. Tokens minted for this mission stop working
                    immediately. This cannot be undone — issue a new mission instead.
                  </>
                ),
                confirmLabel: 'Expire it',
              }}
            />
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Parties" className="lg:col-span-2">
          <dl className="grid grid-cols-2 gap-5 px-5 py-4 sm:grid-cols-4">
            <Field label="Agent" mono>
              <Link
                href={`/agents/${mission.agentId}`}
                className="text-accent-ink underline-offset-4 hover:underline"
              >
                {mission.agentId}
              </Link>
            </Field>
            <Field label="Principal" mono>
              {mission.principalId}
            </Field>
            <Field label="Environment" mono>
              {mission.environment}
            </Field>
            <Field label="Status">
              <StatusChip status={mission.status} />
            </Field>
          </dl>
        </Panel>

        <Panel title="Lifetime">
          <div className="px-5 py-4">
            <p
              className={`text-[1.75rem] leading-none font-semibold tracking-[-0.03em] ${
                live ? 'text-ink' : 'text-deny'
              }`}
            >
              {live ? timeLeft(mission.expiresAt) : 'expired'}
            </p>
            <p className="text-ink-faint mt-1.5 text-xs">
              {absoluteTime(mission.expiresAt)}
              <br />
              issued {absoluteTime(mission.createdAt)}
            </p>
            {live ? null : (
              <p className="text-ink-muted mt-3 text-xs leading-relaxed">
                Requests carrying a token for this mission are refused at step 2 of the decision
                order, before any policy is consulted.
              </p>
            )}
          </div>
        </Panel>
      </div>

      <div className="mt-4">
        <Panel
          title="Scope"
          description="What this mission covers, and what it does with each action. Precedence runs denied → approval → allowed: an action in two groups takes the stricter one."
        >
          <div className="px-5 py-4">
            {permissions.readable ? null : (
              <p className="text-deny mb-4 text-xs">
                The stored permissions document is not in the shape this console knows. It is shown
                raw at the bottom of this page.
              </p>
            )}
            <div className="mb-6">
              <div className="eyebrow">Resources</div>
              {permissions.resources.length === 0 ? (
                <p className="text-ink-faint mt-2 text-xs italic">none</p>
              ) : (
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {permissions.resources.map((resource) => (
                    <li
                      key={resource}
                      className="ident border-line-strong bg-sunken text-ink rounded border px-2 py-1 text-[0.75rem]"
                    >
                      {resource}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="mb-6">
              <div className="eyebrow">Credentials</div>
              {permissions.allowedCredentials.length === 0 ? (
                <p className="text-ink-faint mt-2 text-xs italic">
                  none — every proxy request from this mission is refused at the credential stage
                </p>
              ) : (
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {permissions.allowedCredentials.map((alias) => (
                    <li
                      key={alias}
                      className="ident border-line-strong bg-sunken text-ink rounded border px-2 py-1 text-[0.75rem]"
                    >
                      {alias}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="grid gap-6 md:grid-cols-3">
              <ActionChips
                label="Denied"
                note="Refused even when the credential could do it."
                actions={permissions.deniedActions}
                tone="deny"
              />
              <ActionChips
                label="Needs approval"
                note="Held at 202 until a human approves once."
                actions={permissions.approvalActions}
                tone="review"
              />
              <ActionChips
                label="Allowed"
                note="Forwarded with the credential injected."
                actions={permissions.allowedActions}
                tone="allow"
              />
            </div>
          </div>
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel
          title="Network"
          description="Matched on the logical host, never on the upstream the gateway actually dials. Explicit deny wins; no matching allow rule is a deny."
        >
          <div className="space-y-6 px-5 py-4">
            {network.readable ? null : (
              <p className="text-deny text-xs">
                The stored network document is not in the shape this console knows.
              </p>
            )}
            {rulesTable('Deny', 'Checked first. A match ends the request.', network.deny)}
            {rulesTable(
              'Allow',
              'A request matching none of these is denied by default.',
              network.allow,
            )}
          </div>
        </Panel>

        <Panel
          title="Budget"
          description="Counted per mission and checked before anything is forwarded. Denied requests count too, so probing cannot be free."
        >
          <div className="space-y-5 px-5 py-4">
            {limits.readable ? null : (
              <p className="text-deny text-xs">
                The stored limits document is not in the shape this console knows.
              </p>
            )}
            <UsageBar
              label="Requests"
              used={mission.usage.requestCount}
              limit={limits.maxRequests ?? 0}
              format={count}
            />
            <UsageBar
              label="Bytes transferred"
              used={mission.usage.bytesTotal}
              limit={limits.maxBytes ?? 0}
              format={bytes}
            />
            <div className="border-line border-t pt-4">
              <Field label="Rate ceiling">
                {limits.requestsPerMinute === null
                  ? 'not set'
                  : `${count(limits.requestsPerMinute)} requests per minute`}
              </Field>
            </div>
          </div>
        </Panel>
      </div>

      <div className="mt-4">
        <Panel
          title="Documents as stored"
          description="The exact JSON the policy engine reads. This console renders it, it never interprets it."
        >
          <div className="grid gap-4 px-5 py-4 lg:grid-cols-3">
            <JsonBlock label="permissions" value={mission.permissions} />
            <JsonBlock label="network" value={mission.network} />
            <JsonBlock label="limits" value={mission.limits} />
          </div>
        </Panel>
      </div>

      {permissions.readable || network.readable ? null : (
        <div className="mt-4">
          <Panel>
            <EmptyState title="This mission carries no readable scope">
              Neither document could be read as a mission scope. The gateway denies every request it
              cannot evaluate, so an agent holding this mission can do nothing.
            </EmptyState>
          </Panel>
        </div>
      )}
    </>
  );
}
