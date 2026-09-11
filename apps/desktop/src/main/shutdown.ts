import type { Application } from "./composition.js";

export async function shutdownApplication(application: Application | undefined): Promise<{ status: "complete" | "incomplete"; reason?: string }> {
  if (!application) return { status: "complete" };
  try {
    await application.close();
    return { status: "complete" };
  } catch (error) {
    return { status: "incomplete", reason: error instanceof Error ? error.message : "application shutdown failed" };
  }
}
