type Renderer = { render: (node: unknown) => Promise<string> };

function notInstalled(error: unknown) {
  const code = (error as { code?: string } | null)?.code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

async function load(): Promise<Renderer> {
  try {
    return (await import("@react-email/render")) as Renderer;
  } catch (error) {
    if (!notInstalled(error)) throw error;
  }
  try {
    return (await import("react-email")) as Renderer;
  } catch (error) {
    if (!notInstalled(error)) throw error;
  }
  throw new Error("Failed to render React component. Install `react-email`, or `@react-email/render`, in your project.");
}

export async function render(node: unknown) {
  const { render } = await load();
  return render(node);
}
