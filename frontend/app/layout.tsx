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
    <html lang="en" data-theme="light">
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
try {
  var theme = localStorage.getItem("soc_theme");
  document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
} catch (_) {
  document.documentElement.dataset.theme = "light";
}
`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
