"use client"

import { useState, useEffect } from "react"
import { LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts"

const API = ""
const COLORS = ["#5b8def", "#34d399", "#fbbf24", "#f87171", "#a78bfa", "#fb923c"]
const RANGES = [
  { key: "24h", label: "24H" },
  { key: "7d", label: "7D" },
  { key: "30d", label: "30D" },
]

export default function Dashboard() {
  const [data, setData] = useState<any>(null)
  const [range, setRange] = useState("7d")

  useEffect(() => {
    fetch(`${API}/api/monitoring?range=${range}`).then(r => r.json()).then(setData).catch(() => {})
  }, [range])

  if (!data) return <div className="min-h-screen bg-bg-primary flex items-center justify-center text-text-muted">Loading...</div>

  const buckets = data.buckets || data.daily || []
  const hasData = buckets.length > 0

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary">
      <header className="h-12 border-b border-border flex items-center px-4 gap-3 shrink-0">
        <a href="/" className="text-sm text-accent hover:text-accent-hover">← Back</a>
        <h1 className="text-sm font-semibold">📊 Dashboard</h1>
        <div className="flex gap-1 ml-4">
          {RANGES.map(r => (
            <button key={r.key} onClick={() => setRange(r.key)}
              className={"px-3 py-1 rounded-lg text-xs font-medium transition-colors " + (range === r.key ? "bg-accent text-white" : "bg-bg-secondary text-text-muted hover:text-text-secondary border border-border")}>
              {r.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-text-muted ml-auto">
          Total Tokens: {(data.totalTokens || 0).toLocaleString()} · Errors: {data.totalErrors || 0}
        </span>
      </header>

      {!hasData ? (
        <div className="flex items-center justify-center h-64 text-text-muted text-sm">No data yet. Start a conversation to populate traces.</div>
      ) : (
        <main className="p-6 grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-5xl mx-auto">
          <Card title="Token Usage">
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={buckets}>
                <XAxis dataKey="time" tick={{ fontSize: 10, fill: "var(--color-text-muted)" }} />
                <YAxis tick={{ fontSize: 10, fill: "var(--color-text-muted)" }} />
                <Tooltip contentStyle={{ background: "var(--color-bg-secondary)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }} />
                <Line type="monotone" dataKey="tokens" stroke="#5b8def" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </Card>

          <Card title="Avg Latency (ms)">
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={buckets}>
                <XAxis dataKey="time" tick={{ fontSize: 10, fill: "var(--color-text-muted)" }} />
                <YAxis tick={{ fontSize: 10, fill: "var(--color-text-muted)" }} />
                <Tooltip contentStyle={{ background: "var(--color-bg-secondary)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }} />
                <Line type="monotone" dataKey="avgLatency" stroke="#34d399" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </Card>

          <Card title="Model Usage">
            {data.modelDistribution && data.modelDistribution.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={data.modelDistribution} dataKey="count" nameKey="model" cx="50%" cy="50%" outerRadius={70} label={({ model, count }: any) => `${model}: ${count}`}>
                    {data.modelDistribution.map((_: any, i: number) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  <Tooltip contentStyle={{ background: "var(--color-bg-secondary)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            ) : <div className="flex items-center justify-center h-full text-text-muted text-xs">No model data</div>}
          </Card>

          <Card title="Top Tools">
            {data.topTools && data.topTools.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={data.topTools} layout="vertical">
                  <XAxis type="number" tick={{ fontSize: 10, fill: "var(--color-text-muted)" }} />
                  <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 10, fill: "var(--color-text-secondary)" }} />
                  <Tooltip contentStyle={{ background: "var(--color-bg-secondary)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="count" fill="#5b8def" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : <div className="flex items-center justify-center h-full text-text-muted text-xs">No tool data</div>}
          </Card>
        </main>
      )}
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-bg-secondary border border-border rounded-xl p-4">
      <h3 className="text-xs font-medium text-text-secondary mb-3">{title}</h3>
      {children}
    </div>
  )
}
