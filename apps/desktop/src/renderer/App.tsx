import { useEffect, useMemo, useState } from "react";

type Sample = { sampleId: string; sourceId: string; purpose: string; parserVersion: string };
type JobSnapshot = { job: { id: string; sampleId: string; status: string }; candidates: Array<{ id: string; runId: string; rawRef: { assetId: string }; candidate: { fields: Record<string, { normalized: string | null; status: string }> } }> };
type Diagnostics = { activeRunCount: number; datasetVersion: string; candidateId: string; profileId: string };
type EvidenceView = { assetId: string; sampleId: string; blocks: Array<{ id: string; text: string; page: number | null }> };

const activeStatuses = new Set(["created", "running", "cancelling"]);

export function App() {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [job, setJob] = useState<JobSnapshot | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<EvidenceView | null>(null);
  const [selectedSample, setSelectedSample] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selected = useMemo(() => samples.find((sample) => sample.sampleId === selectedSample), [samples, selectedSample]);

  async function refresh() {
    try {
      const nextSamples = await window.flowmate.listSamples() as Sample[];
      setSamples(nextSamples);
      setDiagnostics(await window.flowmate.getDiagnostics() as Diagnostics);
      const savedJobId = window.localStorage.getItem("flowmate.lastJobId");
      if (savedJobId) {
        try {
          const saved = await window.flowmate.getJob({ jobId: savedJobId }) as JobSnapshot;
          setJob(saved);
          setRunId(saved.candidates.at(-1)?.runId ?? null);
          setSelectedSample((current) => current || saved.job.sampleId);
        } catch {
          window.localStorage.removeItem("flowmate.lastJobId");
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "桌面主进程尚未就绪");
    }
  }

  useEffect(() => { void refresh(); }, []);

  useEffect(() => {
    if (!job?.job.id || !activeStatuses.has(job.job.status)) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      void window.flowmate.getJob({ jobId: job.job.id }).then((next) => {
        if (!stopped) setJob(next as JobSnapshot);
      }).catch(() => {
        // The diagnostic banner remains unchanged; a later manual refresh can
        // recover a database that is being closed during application shutdown.
      });
    }, 250);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [job?.job.id, job?.job.status]);

  useEffect(() => {
    const sample = samples.find((item) => item.sampleId === job?.job.sampleId);
    if (!sample || !job || job.candidates.length === 0) {
      setEvidence(null);
      return;
    }
    let stopped = false;
    void window.flowmate.getEvidence({ jobId: job.job.id, assetId: `original:${sample.sourceId}:${sample.sampleId}` }).then((value) => {
      if (!stopped) setEvidence(value as EvidenceView);
    }).catch(() => {
      if (!stopped) setEvidence(null);
    });
    return () => { stopped = true; };
  }, [job, samples]);

  async function start() {
    if (!selected || !diagnostics || diagnostics.candidateId === "unavailable") return;
    setBusy(true);
    setError(null);
    try {
      const identity = await window.flowmate.start({ sampleId: selected.sampleId, candidateId: diagnostics.candidateId, clientRequestId: crypto.randomUUID() }) as { jobId: string; runId: string };
      setRunId(identity.runId);
      window.localStorage.setItem("flowmate.lastJobId", identity.jobId);
      const snapshot = await window.flowmate.getJob({ jobId: identity.jobId }) as JobSnapshot;
      setJob(snapshot);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "启动失败");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!job || !runId) return;
    try {
      await window.flowmate.cancel({ runId });
      const snapshot = await window.flowmate.getJob({ jobId: job.job.id }) as JobSnapshot;
      setJob(snapshot);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "取消失败");
    }
  }

  return (
    <main className="shell">
      <header>
        <div>
          <p className="eyebrow">FLOWMATE / P0</p>
          <h1>发票字段抽取</h1>
          <p className="subtitle">真实 Pi Runtime · 受控输入 · 可追溯候选</p>
        </div>
        <button className="secondary" onClick={() => void refresh()}>刷新诊断</button>
      </header>
      {error && <div className="notice error">{error}</div>}
      <section className="grid">
        <article className="card">
          <div className="card-title"><h2>样本</h2><span>{samples.length} 条</span></div>
          <label htmlFor="sample">选择已解析文件</label>
          <select id="sample" value={selectedSample} onChange={(event) => setSelectedSample(event.target.value)}>
            <option value="">请选择样本</option>
            {samples.map((sample) => <option key={sample.sampleId} value={sample.sampleId}>{sample.sampleId} · {sample.purpose}</option>)}
          </select>
          {selected && <dl className="facts"><div><dt>来源</dt><dd>{selected.sourceId}</dd></div><div><dt>Parser</dt><dd>{selected.parserVersion}</dd></div></dl>}
          <button className="primary" disabled={!selected || busy || diagnostics?.candidateId === "unavailable"} onClick={() => void start()}>{busy ? "运行中…" : "开始抽取"}</button>
          <button className="secondary wide" disabled={!job || !runId} onClick={() => void cancel()}>请求取消</button>
        </article>
        <article className="card">
          <div className="card-title"><h2>Run 状态</h2>{job && <span className={"status " + job.job.status}>{job.job.status}</span>}</div>
          {!job && <p className="muted">尚未启动 Run。</p>}
          {job && <>
            <p className="run-id">{job.job.id}</p>
            {job.candidates.length > 0 && <div className="notice success">候选已接受</div>}
            {job.job.status === "failed" && <div className="notice error">抽取失败</div>}
            {job.job.status === "cancelled" && <div className="notice">已取消</div>}
            <div className="fields">{job.candidates.flatMap((candidate) => Object.entries(candidate.candidate.fields).map(([name, field]) => <div className="field" key={`${candidate.id}-${name}`}><span>{name}</span><strong>{field.normalized ?? "未提取"}</strong><em>{field.status}</em></div>))}</div>
          </>}
        </article>
        <article className="card evidence">
          <div className="card-title"><h2>证据</h2>{evidence && <span>{evidence.blocks.length} 个区块</span>}</div>
          {!evidence && <p className="muted">候选接受后显示获准原文区块。</p>}
          {evidence?.blocks.map((block) => <div className="evidence-block" key={block.id}><span>{block.id}{block.page ? ` · 第 ${block.page} 页` : ""}</span><p>{block.text}</p></div>)}
        </article>
        <article className="card diagnostics">
          <div className="card-title"><h2>诊断</h2><span className="dot" /></div>
          {diagnostics ? <dl className="facts"><div><dt>数据版本</dt><dd>{diagnostics.datasetVersion}</dd></div><div><dt>候选</dt><dd>{diagnostics.candidateId}</dd></div><div><dt>Profile</dt><dd>{diagnostics.profileId}</dd></div><div><dt>活动 Run</dt><dd>{diagnostics.activeRunCount}</dd></div></dl> : <p className="muted">等待主进程。</p>}
        </article>
      </section>
      <footer>结果状态代表技术执行结果；复核、审批与正式提交在后续阶段接入。</footer>
    </main>
  );
}
