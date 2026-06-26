import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SOC AI Agent",
  description: "SOC AI Agent admin dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
try {
  var stored = localStorage.getItem("soc_theme");
  var theme = stored === "dark" || stored === "light" ? stored : "light";
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
} catch (_) {
  document.documentElement.dataset.theme = "light";
  document.documentElement.style.colorScheme = "light";
}
`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
