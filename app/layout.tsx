import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "XAUUSD · APEX — Volume Profile Predictor",
  description: "Anchored volume profile predictor for XAU/USD with momentum breakout logic",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0 }}>{children}</body>
    </html>
  );
}
