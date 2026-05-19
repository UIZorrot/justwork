import { BackendApiError } from "@/features/backend/client";

/**
 * 将后端 / 异常转为面向用户的简短中文说明（用于 Toast、提示文案等）。
 */
export function formatBackendOrUnknownError(err: unknown): string {
  if (err instanceof BackendApiError) {
    return mapBackendApiError(err);
  }
  if (err instanceof Error && err.message.trim()) {
    return err.message.trim();
  }
  return "操作失败，请稍后重试。";
}

function mapBackendApiError(e: BackendApiError): string {
  switch (e.code) {
    case "invalid_workspace_password":
      return "工作区密码不正确，请检查后重试。";
    case "unauthorized":
      return "未授权访问 API（请检查令牌或服务端配置）。";
    case "not_found":
      return "未找到对应资源。";
    case "conflict":
      return "与其他修改冲突，请刷新或同步后重试。";
    case "workspace_create_limit_exceeded":
      return "每个用户最多只能创建 5 个工作区。";
    case "http_error":
      return e.message || "网络请求失败。";
    default:
      return e.message.trim() || "请求失败";
  }
}
