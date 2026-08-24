import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

const baseMetadata: Metadata = {
  title: "Nivasa | Society Maintenance, Made Clear",
  description:
    "Raise, track, and resolve society maintenance requests with transparent updates, notices, and community-wide visibility.",
  applicationName: "Nivasa",
  authors: [{ name: "Nivasa" }],
  keywords: [
    "society maintenance",
    "resident complaints",
    "apartment management",
    "notice board",
  ],
};

export async function generateMetadata(): Promise<Metadata> {
  const incomingHeaders = await headers();
  const forwardedHost = incomingHeaders.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || incomingHeaders.get("host") || "localhost:3000";
  const forwardedProtocol = incomingHeaders
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  const protocol = forwardedProtocol || (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const socialImage = `${origin}/og.png`;

  return {
    ...baseMetadata,
    metadataBase: new URL(origin),
    alternates: { canonical: origin },
    openGraph: {
      type: "website",
      url: origin,
      title: "Nivasa | Society Maintenance, Made Clear",
      description:
        "A calm, transparent place for residents and society teams to resolve maintenance issues.",
      siteName: "Nivasa",
      images: [
        {
          url: socialImage,
          width: 1731,
          height: 909,
          alt: "Nivasa society maintenance dashboard",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "Nivasa | Society Maintenance, Made Clear",
      description:
        "A calm, transparent place for residents and society teams to resolve maintenance issues.",
      images: [socialImage],
    },
  };
}

export const viewport: Viewport = {
  themeColor: "#f4f6f2",
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
