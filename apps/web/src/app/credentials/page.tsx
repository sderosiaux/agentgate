import type { ReactElement } from 'react';
import { EmptyState } from '@/components/EmptyState';
import { ErrorPanel, PageHeader, Panel } from '@/components/Panel';
import { StatusChip } from '@/components/StatusChip';
import { api, describeError } from '@/lib/api';
import type { Credential } from '@/lib/types';

/**
 * Aliases, and only aliases.
 *
 * This page renders named fields one at a time — never the credential object — so there is no
 * code path here that could print a secret even if the management API were changed to send one.
 * That is the point of the poisoned-fixture test: an API answer carrying `value` must render
 * exactly the same screen as one without it.
 */
function CredentialCard({ credential }: { credential: Credential }): ReactElement {
  return (
    <li className="card flex flex-col overflow-hidden">
      <div className="border-line flex items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <p className="ident text-ink text-sm font-semibold">{credential.alias}</p>
          <p className="text-ink-faint mt-0.5 text-xs">what an agent names in a request</p>
        </div>
        <StatusChip status={credential.status} />
      </div>

      <dl className="flex-1 space-y-3 px-4 py-3.5">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="eyebrow">Provider</dt>
          <dd className="ident text-ink text-xs">{credential.provider}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="eyebrow">Logical host</dt>
          <dd className="ident text-ink text-xs break-all">{credential.logicalHost}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="eyebrow">Upstream</dt>
          <dd className="ident text-ink-muted text-xs break-all">{credential.upstreamBaseUrl}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="eyebrow">Injection</dt>
          <dd className="ident text-ink text-xs">
            {credential.injection.type}: {credential.injection.name}
          </dd>
        </div>
      </dl>

      <p className="bg-sunken border-line text-ink-faint border-t px-4 py-2.5 text-xs leading-snug">
        The value is encrypted at rest and injected by the gateway after an ALLOW. It is not
        readable through any API, and this console has no field for it.
      </p>
    </li>
  );
}

export default async function CredentialsPage(): Promise<ReactElement> {
  const header = (
    <PageHeader
      eyebrow="Broker"
      title="Credentials"
      description="Agents hold aliases, never secrets. The gateway resolves an alias to a real credential only after a request has been allowed, and injects it on the way out."
    />
  );

  let credentials: Credential[];
  try {
    credentials = await api.credentials();
  } catch (error) {
    return (
      <>
        {header}
        <ErrorPanel title="The gateway did not answer" detail={describeError(error)} />
      </>
    );
  }

  if (credentials.length === 0) {
    return (
      <>
        {header}
        <Panel>
          <EmptyState
            title="No credential has been registered"
            hint="POST /api/v1/credentials { alias, provider, logicalHost, upstreamBaseUrl, injection, value }"
          >
            A credential is stored once, encrypted with the gateway&rsquo;s master key, and read
            back only by the forwarder. The <code className="ident">value</code> field is
            write-only: no endpoint returns it, so nothing can be listed here but the alias an agent
            would name and where it points.
          </EmptyState>
        </Panel>
      </>
    );
  }

  return (
    <>
      {header}
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {credentials.map((credential) => (
          <CredentialCard key={credential.id} credential={credential} />
        ))}
      </ul>
      <p className="text-ink-faint mt-6 max-w-2xl text-xs leading-relaxed">
        Capability and authority are separate on purpose. A credential describes what is technically
        possible; the mission decides what is allowed. A request the credential could satisfy is
        still refused when no mission covers it.
      </p>
    </>
  );
}
