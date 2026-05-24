import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "DataWhale",
  description: "AI-native data agent — ask questions, get insights",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="h-screen overflow-hidden">
        {children}
      </body>
    </html>
  )
}
