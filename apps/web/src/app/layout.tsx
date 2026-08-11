import type { Metadata } from 'next';
import { IBM_Plex_Mono, Instrument_Sans } from 'next/font/google';
import type { ReactElement, ReactNode } from 'react';
import { Sidebar } from '@/components/Sidebar';
// `gatewayHost` rather than GATEWAY_URL itself: the rail prints this, and a connection string
// may carry credentials. One reduction, used everywhere a gateway address reaches a page.
import { api, gatewayHost } from '@/lib/api';
import './globals.css';

const sans = Instrument_Sans({
  subsets: ['latin'],
  variable: '--font-instrument-sans',
  display: 'swap',
});

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'AgentGate console',
  description: 'Runtime authorization for AI agents — missions, decisions and the trail of both.',
};

/** Nothing in this console is cacheable: it shows what the gateway believes right now. */
export const dynamic = 'force-dynamic';

/**
 * The queue depth shown on the rail. Fetched here so it is right on every page, and swallowed on
 * failure: a badge is not worth taking the whole console down for, and the Approvals page itself
 * reports the outage properly.
 */
async function pendingApprovals(): Promise<number | null> {
  try {
    return (await api.overview()).pendingApprovals;
  } catch {
    return null;
  }
}

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}): Promise<ReactElement> {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="flex min-h-dvh">
        <Sidebar gatewayHost={gatewayHost()} pendingApprovals={await pendingApprovals()} />
        <main className="min-w-0 flex-1 px-6 py-8 lg:px-10 lg:py-10">
          <div className="mx-auto max-w-[76rem]">{children}</div>
        </main>
      </body>
    </html>
  );
}
