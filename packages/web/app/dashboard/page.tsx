"use client"

import { useState, useEffect } from "react"
import { LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts"

const API = ""
const COLORS = ["#5b8def", "#34d399", "#fbbf24", "#f87171", "#a78bfa", "#fb923c"]

export default function Dashboard() {
  const [data, setData] = useState<any>(null)

  useEffect(() => {
    fetch(`${API}/api/monitoring`).then(r => r.json()).then(setData).catch(() => {})
  }, [])

  if (!data) return <div className="min-h-screen bg-bg-primary flex items-center justify-center text-text-muted">Loading...</div>

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary">
      <header className="h-12 border-b border-border flex items-center px-4 gap-3">
        <a href="/" className="text-sm text-accent hover:text-accent-hover">← Back</a>
        <h1 className="text-sm font-semibold">📊 Dashboard</h1>
        <span className="text-xs text-text-muted ml-auto">
          Total Tokens: {data.totalTokens?.toLocaleString()} · Errors: {data.totalErrors}
        </span>
      </header>
      <main className="p-6 grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-5xl mx-auto">
        {/* Daily Tokens */}
        <Card title="Token Usage (Daily)">
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={data.daily}>
              <XAxis dataKey="day" tick={{ fontSize: 10, fill: "var(--text-muted)" }} />
              <YAxis tick={{ fontSize: 10, fill: "var(--text-muted)" }} />
              <Tooltip contentStyle={{ background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} />
              <Line type="monotone" dataKey="tokens" stroke="#5b8def" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </Card>

        {/* Daily Latency */}
        <Card title="Avg Latency (Daily)">
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={data.daily}>
              <XAxis dataKey="day" tick={{ fontSize: 10, fill: "var(--text-muted)" }} />
              <YAxis tick={{ fontSize: 10, fill: "var(--text-muted)" }} unit="ms" />
              <Tooltip contentStyle={{ background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} />
              <Line type="monotone" dataKey="avgLatency" stroke="#34d399" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </Card>

        {/* Model Distribution */}
        <Card title="Model Usage">
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={data.modelDistribution} dataKey="count" nameKey="model" cx="50%" cy="50%" outerRadius={70} label={({ model, count }) => `${model}: ${count}`}>
                {data.modelDistribution?.map((_: any, i: number) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip contentStyle={{ background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </Card>

        {/* Top Tools */}
        <Card title="Top Tools">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={data.topTools} layout="vertical">
              <XAxis type="number" tick={{ fontSize: 10, fill: "var(--text-muted)" }} />
              <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 10, fill: "var(--text-secondary)" }} />
              <Tooltip contentStyle={{ background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} />
              <Bar dataKey="count" fill="#5b8def" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </main>
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
