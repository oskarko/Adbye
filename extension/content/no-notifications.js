// Runs in the page's own world. Denies web push notification prompts, which
// AdBlock Premium sells as "block push notification requests".

(() => {
  const denied = () => Promise.resolve("denied");
  if (globalThis.Notification) {
    try {
      Object.defineProperty(Notification, "permission", { get: () => "denied", configurable: true });
      Notification.requestPermission = function requestPermission(callback) {
        if (typeof callback === "function") queueMicrotask(() => callback("denied"));
        return denied();
      };
    } catch {}
  }
  if (globalThis.PushManager) {
    PushManager.prototype.subscribe = function subscribe() {
      return Promise.reject(new DOMException("Push subscriptions are blocked by AdBye", "NotAllowedError"));
    };
    PushManager.prototype.permissionState = denied;
  }
})();
