"use client"

import { useState, useEffect } from "react"

const API = ""
const KEYS = [
  { key: "DEEPSEEK_API_KEY", label: "DeepSeek API Key", required: true },
  { key: "TAVILY_API_KEY", label: "Tavily Search API Key" },
  { key: "E2B_API_KEY", label: "E2B Sandbox API Key" },
]

export default function Settings() {
  const [config, setConfig] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch(`${API}/api/config`).then(r => r.json()).then(setConfig).catch(() => {})
  }, [])

  const save = async () => {
    await fetch(`${API}/api/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config) })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary">
      <header className="h-12 border-b border-border flex items-center px-4 gap-3">
        <a href="/" className="text-sm text-accent hover:text-accent-hover">← Back</a>
        <h1 className="text-sm font-semibold">⚙️ Settings</h1>
      </header>
      <main className="max-w-xl mx-auto p-6 space-y-6">
        <section>
          <h2 className="text-sm font-semibold mb-3">API Keys</h2>
          <div className="space-y-3">
            {KEYS.map(({ key, label, required }) => (
              <div key={key}>
                <label className="block text-xs text-text-secondary mb-1">{label}{required ? " *" : ""}</label>
                <input type="password" value={config[key] || ""}
                  onChange={e => setConfig(c => ({ ...c, [key]: e.target.value }))}
                  placeholder={key}
                  className="w-full bg-bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-muted outline-none focus:border-accent" />
              </div>
            ))}
          </div>
        </section>
        <button onClick={save} className="px-6 py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent-hover transition-colors">
          {saved ? "✓ Saved" : "Save"}
        </button>
        <p className="text-xs text-text-muted">Keys are stored in ~/.datawhale/config.json</p>
      </main>
    </div>
  )
}
