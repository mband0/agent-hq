'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { Settings } from 'lucide-react';

const TABS = [
  { label: 'Providers', href: '/settings/providers' },
  { label: 'OpenClaw Gateway', href: '/settings/gateway' },
  { label: 'Model Routing', href: '/settings/model-routing' },
  { label: 'GitHub', href: '/settings/github' },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <Settings className="w-5 h-5 text-amber-400" />
          <h1 className="text-2xl font-bold text-white">Settings</h1>
        </div>

        {/* Tabs */}
        <div className="flex gap-0 border-b border-zinc-700/60">
          {TABS.map(tab => {
            const active = pathname === tab.href || pathname.startsWith(tab.href + '/');
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  active
                    ? 'border-amber-400 text-white'
                    : 'border-transparent text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </div>
      </div>

      {/* Content */}
      {children}
    </div>
  );
}
