import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/context/auth-context";

// The typeface the Trossen SDK webapp uses, exposed as a variable so the
// stylesheet can hand it to both the sans and mono slots.
const brandFont = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-brand",
});

export const metadata: Metadata = {
  title: "Trossen Dataset Viewer",
  description: "Review LeRobot datasets and raw MCAP recordings",
  icons: { icon: "/icon.svg" },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${brandFont.variable} ${brandFont.className}`}>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
