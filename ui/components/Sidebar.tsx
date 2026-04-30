'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Bot,

  BookOpen,
  ScrollText,
  Zap,
  Menu,
  FolderOpen,
  Files,
  MessageSquare,
  ClipboardList,
  Rocket,
  Workflow,
  BarChart3,
  GitBranch,
  Cpu,
  Settings,
  HelpCircle,
} from 'lucide-react';
import { beginGettingStartedGuide } from '@/lib/gettingStarted';

const navItems = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/agents', label: 'Agents', icon: Bot },
  { href: '/tasks', label: 'Tasks', icon: ClipboardList },
  { href: '/projects', label: 'Projects', icon: FolderOpen },
  { href: '/sprints', label: 'Sprints', icon: Rocket },
  { href: '/sprint-definitions', label: 'Sprint Definitions', icon: Workflow },
  { href: '/routing', label: 'Task Routing', icon: GitBranch },
  { href: '/settings/model-routing', label: 'Model Routing', icon: Cpu },
  { href: '/telemetry', label: 'Telemetry', icon: BarChart3 },
  { href: '/capabilities', label: 'Capabilities', icon: BookOpen },
  { href: '/workspaces', label: 'Workspaces', icon: Files },
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/settings/providers', label: 'Settings', icon: Settings },
  { href: '/logs', label: 'Logs', icon: ScrollText },
];

// Bottom nav items (mobile — primary 4 + a scrollable overflow menu)
const mobileNavItems = [
  { href: '/', label: 'Home', icon: LayoutDashboard },
  { href: '/tasks', label: 'Tasks', icon: ClipboardList },
  { href: '/agents', label: 'Agents', icon: Bot },
  { href: '/sprints', label: 'Sprints', icon: Rocket },
  { href: '/chat', label: 'Chat', icon: MessageSquare },
];

export default function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    // Default collapsed on mobile
    const stored = localStorage.getItem('sidebar-collapsed');
    if (stored !== null) {
      setCollapsed(stored === 'true');
    } else {
      setCollapsed(window.innerWidth < 768);
    }
  }, []);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem('sidebar-collapsed', String(next));
    window.dispatchEvent(new Event('sidebar-toggle'));
  };

  return (
    <>
      {/* Desktop sidebar — hidden on mobile */}
      <aside className={`hidden md:flex fixed left-0 top-0 bottom-0 bg-slate-950 border-r border-slate-800 flex-col z-[45] transition-all duration-200 ${collapsed ? 'w-14' : 'w-60'}`}>
        {/* Header */}
        {collapsed ? (
          <div className="flex flex-col items-center py-4 border-b border-slate-800 gap-3">
            <button
              onClick={toggle}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              title="Expand sidebar"
            >
              <Menu className="w-5 h-5" />
            </button>
            <Zap className="w-5 h-5 text-amber-400" />
          </div>
        ) : (
          <div className="px-4 py-4 border-b border-slate-800 flex items-start justify-between">
            <div className="flex items-center gap-2">
              <Zap className="text-amber-400 w-5 h-5 shrink-0" />
              <div>
                <span className="font-bold text-white text-base tracking-tight">Agent HQ</span>
                <p className="text-slate-500 text-xs">Agent Control Center</p>
              </div>
            </div>
            <button
              onClick={toggle}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors shrink-0 ml-2"
              title="Collapse sidebar"
            >
              <Menu className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Nav */}
        <nav className={`flex-1 py-3 space-y-0.5 ${collapsed ? 'px-1' : 'px-3'}`}>
          {navItems.map(({ href, label, icon: Icon }) => {
            const isActive = href === '/'
              ? pathname === '/'
              : href === '/capabilities'
                ? pathname.startsWith('/capabilities') || pathname.startsWith('/skills')
                : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                title={collapsed ? label : undefined}
                className={`flex items-center rounded-lg text-sm font-medium transition-colors ${
                  collapsed ? 'justify-center p-2.5' : 'gap-3 px-3 py-2.5'
                } ${isActive ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800/50'}`}
              >
                <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-amber-400' : ''}`} />
                {!collapsed && label}
              </Link>
            );
          })}
        </nav>

        {/* Footer */}
        {!collapsed && (
          <div className="px-5 py-4 border-t border-slate-800">
            <button
              type="button"
              onClick={() => beginGettingStartedGuide(0)}
              className="mb-3 inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-slate-500 hover:text-white"
            >
              <HelpCircle className="w-3.5 h-3.5 text-amber-400" />
              Getting Started
            </button>
            <p className="text-slate-600 text-xs">v1.0 · Phase 1+2</p>
          </div>
        )}
        {collapsed && (
          <div className="px-1 py-3 border-t border-slate-800 flex justify-center">
            <button
              type="button"
              onClick={() => beginGettingStartedGuide(0)}
              className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              title="Replay getting started guide"
            >
              <HelpCircle className="w-4 h-4 text-amber-400" />
            </button>
          </div>
        )}
      </aside>

      {/* Mobile bottom tab bar — visible only on mobile, horizontally scrollable */}
      <nav className="md:hidden order-2 z-[45] w-full shrink-0 bg-slate-950 border-t border-slate-800 pb-[env(safe-area-inset-bottom,0px)]">
        <div className="flex items-center overflow-x-auto scrollbar-none px-1 py-1">
          {navItems.map(({ href, label, icon: Icon }) => {
            const isActive = href === '/'
              ? pathname === '/'
              : href === '/capabilities'
                ? pathname.startsWith('/capabilities') || pathname.startsWith('/skills')
                : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={`flex flex-col items-center gap-0.5 px-3 py-2 rounded-lg transition-colors shrink-0 min-w-[56px] ${
                  isActive ? 'text-amber-400' : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                <Icon className="w-5 h-5" />
                <span className="text-[10px] font-medium leading-none">{label}</span>
              </Link>
            );
          })}
          <button
            type="button"
            onClick={() => beginGettingStartedGuide(0)}
            className="flex flex-col items-center gap-0.5 px-3 py-2 rounded-lg transition-colors shrink-0 min-w-[56px] text-slate-500 hover:text-slate-300"
          >
            <HelpCircle className="w-5 h-5 text-amber-400" />
            <span className="text-[10px] font-medium leading-none">Guide</span>
          </button>
        </div>
      </nav>
    </>
  );
}
