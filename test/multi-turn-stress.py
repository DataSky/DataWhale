#!/usr/bin/env python3
"""Multi-turn stress test: 10 rounds, verify no message corruption."""
import subprocess, json, time, urllib.request, sys, os

BASE = "http://localhost:3000"
ROUNDS = 10
PROMPTS = [
    "用中文回答：什么是机器学习？",
    "搜索互联网，介绍下Transformer架构",
    "简单回答：Python和R的区别是什么？",
    "列出5种常见的数据可视化图表类型",
    "搜索互联网，介绍下DeepSeek V3的特点",
    "什么是过拟合？如何避免？",
    "简单回答：SQL和NoSQL的区别",
    "列出常用的Python数据分析库",
    "搜索互联网，介绍下最新的大模型发展趋势",
    "总结我们聊过的所有话题",
]

def api(path, data=None, method="GET"):
    url = f"{BASE}{path}"
    if data is not None:
        req = urllib.request.Request(url, data=json.dumps(data).encode(), headers={"Content-Type": "application/json"}, method=method)
    else:
        req = urllib.request.Request(url, method=method)
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read())

def sse_chat(prompt, session_id):
    """Send chat request, collect SSE events, return status."""
    import http.client
    body = json.dumps({"prompt": prompt, "sessionId": session_id}).encode()
    conn = http.client.HTTPConnection("localhost", 3000, timeout=120)
    conn.request("POST", "/api/chat", body, {"Content-Type": "application/json"})
    resp = conn.getresponse()
    
    status = "unknown"
    session_id_out = session_id
    events = []
    
    buffer = ""
    while True:
        chunk = resp.read(4096)
        if not chunk:
            break
        buffer += chunk.decode()
        while "\n\n" in buffer:
            msg, buffer = buffer.split("\n\n", 1)
            for line in msg.split("\n"):
                if line.startswith("data: "):
                    try:
                        ev = json.loads(line[6:])
                        events.append(ev)
                        if ev.get("sessionId") and not session_id_out:
                            session_id_out = ev["sessionId"]
                        if ev["type"] == "agent_end":
                            status = ev.get("status", "done")
                    except:
                        pass
    
    conn.close()
    return status, session_id_out, events

def check_db(session_id):
    """Verify database consistency."""
    result = subprocess.run(
        ["sqlite3", os.path.expanduser("~/.datawhale/sessions.db"),
         f"SELECT COUNT(*) FROM messages WHERE session_id='{session_id}';"
         f"SELECT COUNT(*) FROM queries WHERE session_id='{session_id}';"
         f"SELECT message_count FROM sessions WHERE id='{session_id}';"
         f"SELECT COUNT(*) FROM messages WHERE session_id='{session_id}' AND role='user';"
         f"SELECT COUNT(*) FROM messages WHERE session_id='{session_id}' AND role='tool_result' AND content='';"
        ],
        capture_output=True, text=True
    )
    lines = result.stdout.strip().split("\n")
    return {
        "total_messages": int(lines[0]),
        "total_queries": int(lines[1]),
        "session_msg_count": int(lines[2]),
        "user_count": int(lines[3]),
        "empty_tool_results": int(lines[4]),
    }

def main():
    # Kill old server, start new one
    subprocess.run(["lsof", "-ti", ":3000"], capture_output=True)
    subprocess.run(["pkill", "-f", "bun.*cli.*serve"], capture_output=True)
    time.sleep(1)
    
    # Start server
    server = subprocess.Popen(
        ["bun", "run", "packages/cli/src/index.ts", "serve"],
        cwd="/Users/wangteng06/AiCode/CodeWhaleDemo/DataWhale",
        stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    time.sleep(4)
    
    # Verify server is up
    try:
        api("/api/sessions")
    except:
        print("FAIL: Server not reachable")
        server.kill()
        sys.exit(1)
    
    print(f"=== Multi-turn stress test: {ROUNDS} rounds ===\n")
    
    session_id = None
    results = []
    
    for i in range(ROUNDS):
        prompt = PROMPTS[i]
        print(f"Round {i+1}: {prompt[:50]}...", end=" ", flush=True)
        
        status, session_id, events = sse_chat(prompt, session_id)
        
        has_error = any(e["type"] == "error" for e in events)
        error_msg = ""
        if has_error:
            for e in events:
                if e["type"] == "error":
                    error_msg = e.get("message", e.get("error", ""))[:80]
                    break
        
        results.append({
            "round": i+1,
            "status": status,
            "error": error_msg,
            "session_id": session_id,
            "event_count": len(events),
        })
        
        if status == "done" and not has_error:
            print("✓ OK")
        else:
            print(f"✗ {status} {error_msg}")
    
    # Verify database
    print("\n=== Database verification ===")
    db = check_db(session_id)
    print(f"  Total messages: {db['total_messages']}")
    print(f"  Total queries:  {db['total_queries']}")
    print(f"  Session msg_count: {db['session_msg_count']}")
    print(f"  User messages:  {db['user_count']}")
    print(f"  Empty tool_results: {db['empty_tool_results']}")
    
    # Checks
    ok = True
    pass_count = sum(1 for r in results if r["status"] == "done")
    print(f"\n  Passed: {pass_count}/{ROUNDS}")
    if pass_count < ROUNDS:
        print("  FAIL: Not all rounds completed successfully")
        ok = False
    
    if db["user_count"] != ROUNDS:
        print(f"  FAIL: user_count={db['user_count']} != {ROUNDS}")
        ok = False
    
    if db["session_msg_count"] != db["total_messages"]:
        print(f"  FAIL: session.message_count ({db['session_msg_count']}) != actual ({db['total_messages']})")
        ok = False
    
    if db["total_queries"] != ROUNDS:
        print(f"  FAIL: queries={db['total_queries']} != {ROUNDS}")
        ok = False
    
    if db["empty_tool_results"] > 0:
        print(f"  FAIL: {db['empty_tool_results']} empty tool_result messages")
        ok = False
    
    # Check no message explosion (> ROUNDS * 10 would be suspicious)
    max_expected = ROUNDS * 8  # generous: user + assistant + tools per round
    if db["total_messages"] > max_expected:
        print(f"  WARN: message count {db['total_messages']} > {max_expected} (possible bloat)")
    
    if ok:
        print("\n✓ ALL CHECKS PASSED")
    else:
        print("\n✗ SOME CHECKS FAILED")
    
    server.kill()
    return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main())
