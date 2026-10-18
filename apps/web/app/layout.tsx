import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Inkwell',
  description: 'Real-time collaborative Markdown editor',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <a href="/">Inkwell</a>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
