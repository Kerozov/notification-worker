export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Email Worker</h1>
      <p>Dispatch service for tenant email jobs.</p>
      <p>
        API: <code>/api/v1/send</code>, <code>/api/v1/schedule</code>,{" "}
        <code>/api/v1/sms/send</code>, <code>/api/v1/sms/schedule</code>
      </p>
      <p>
        Admin: <code>/admin</code>
      </p>
    </main>
  );
}
