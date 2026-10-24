export function workerActivity(worker: { state?: string | null; active_jobs: number; available_slots: number; last_error?: string }, queueDepth: number): string {
  const labels: Record<string, string> = {
    stopped: "Đã dừng xử lý — bật lại tại Quản lý worker để nhận job.",
    paused: "Đang tạm dừng nhận job.",
    draining: "Đang dừng an toàn — không nhận thêm job.",
    stopping: "Đang dừng xử lý.",
    starting: "Đang khởi động — chưa sẵn sàng nhận job.",
    error: "Worker gặp lỗi — kiểm tra tại Quản lý worker.",
  };
  if (worker.state && labels[worker.state]) return [labels[worker.state], worker.last_error].filter(Boolean).join(" ");
  if (worker.active_jobs > 0) return `Đang xử lý ${worker.active_jobs} job.`;
  if (worker.available_slots === 0) return "Worker chưa sẵn sàng nhận job — kiểm tra tại Quản lý worker.";
  return queueDepth > 0 ? `Queue còn ${queueDepth} job — đang chờ worker nhận việc.` : "Đang rảnh — queue không có job.";
}
