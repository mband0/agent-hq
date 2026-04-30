'use client';

import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { api } from '@/lib/api';
import OnboardingWizard, { markOnboarded } from './OnboardingWizard';
import ChatWidget from './ChatWidget';
import GettingStartedGuide from './GettingStartedGuide';

// Routes that should fill the full height without padding wrapper
const FULL_HEIGHT_ROUTES = ['/chat', '/tasks'];
// Route prefixes that should also fill full height
const FULL_HEIGHT_PREFIXES = ['/sprints/'];

export default function MainContent({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const pathname = usePathname();
  const isFullHeight = FULL_HEIGHT_ROUTES.includes(pathname) || FULL_HEIGHT_PREFIXES.some(p => pathname.startsWith(p));

  useEffect(() => {
    const check = () => {
      const stored = localStorage.getItem('sidebar-collapsed');
      if (stored !== null) {
        setCollapsed(stored === 'true');
      } else {
        setCollapsed(window.innerWidth < 768);
      }
    };
    check();
    window.addEventListener('sidebar-toggle', check);
    return () => window.removeEventListener('sidebar-toggle', check);
  }, []);

  // First-run detection: show onboarding if not yet onboarded
  // Server-side onboarding state is authoritative; localStorage is only a UI hint.
  useEffect(() => {
    api.getSetupStatus()
      .then(status => {
        if (status.onboarding_completed) {
          // Server says onboarding is done — sync localStorage and skip wizard
          markOnboarded();
          return;
        }
        if (!status.hasProjects) {
          setShowOnboarding(true);
        } else if (status.onboarding_provider_gate_passed) {
          // Projects exist and provider gate passed — mark silently
          markOnboarded();
        } else {
          // Projects exist but no providers yet — show onboarding to collect provider
          setShowOnboarding(true);
        }
      })
      .catch(() => {
        // API not available; fall back to the persisted local hint
        if (localStorage.getItem('atlas-hq-onboarded') !== '1') {
          setShowOnboarding(true);
        }
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // On mobile: no sidebar offset (sidebar is hidden, replaced by bottom tab bar)
  // On desktop (md+): offset by sidebar width (collapsed = 56px / expanded = 240px)
  const desktopMargin = collapsed ? 'md:ml-14' : 'md:ml-60';

  return (
    <>
      {showOnboarding && (
        <OnboardingWizard onClose={() => setShowOnboarding(false)} />
      )}
    <main className={`flex-1 min-h-0 overflow-y-auto overscroll-none md:overflow-hidden flex flex-col transition-all duration-200 ${desktopMargin}`}>
      {isFullHeight ? (
        <div className="flex-1 min-h-0 pb-[calc(4rem+env(safe-area-inset-bottom,0px))] md:pb-0 flex flex-col md:overflow-hidden">
          {children}
        </div>
      ) : (
        // Mobile bottom padding should only reserve the actual tab bar height plus safe area once.
        <div className="flex-1 min-h-0 p-4 md:p-6 pb-[calc(4rem+env(safe-area-inset-bottom,0px))] md:pb-6 overflow-y-auto md:overflow-y-auto">
          <div className="max-w-7xl mx-auto">
            {children}
          </div>
        </div>
      )}
    </main>
      {!showOnboarding && pathname !== '/chat' && <ChatWidget />}
      {!showOnboarding && <GettingStartedGuide />}
    </>
  );
}
