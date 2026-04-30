import type { Metadata } from 'next';
import './globals.css';
import Sidebar from '@/components/Sidebar';
import MainContent from '@/components/MainContent';
export const metadata: Metadata = {
  title: 'Agent HQ',
  description: 'Agent management dashboard',
};

// v2 - mobile responsive
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-slate-900 text-slate-100 h-[var(--app-viewport-height)] min-h-0 overflow-hidden flex flex-col md:flex-row">
        <Sidebar />
        <MainContent>{children}</MainContent>
      </body>
    </html>
  );
}
