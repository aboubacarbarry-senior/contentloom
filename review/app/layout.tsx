import type { ReactNode } from 'react';
import { Nav } from '../components/Nav';
import { ToastProvider } from '../components/Toasts';
import './globals.css';

export const metadata = {
  title: 'ContentLoom review',
  description: 'Review, edit and publish generated product copy.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ToastProvider>
          <div className="shell">
            <Nav />
            <main className="main">{children}</main>
          </div>
        </ToastProvider>
      </body>
    </html>
  );
}
