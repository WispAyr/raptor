import { useEffect, useRef, useCallback } from 'react';

export type WSMessage = Record<string, unknown> & { type: string };

interface UseWebSocketOptions {
  onMessage?: (msg: WSMessage) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

export function useWebSocket(url: string, options: UseWebSocketOptions = {}) {
  const ws = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const connect = useCallback(() => {
    if (ws.current?.readyState === WebSocket.OPEN) return;

    ws.current = new WebSocket(url);

    ws.current.onopen = () => {
      optionsRef.current.onOpen?.();
    };

    ws.current.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as WSMessage;
        optionsRef.current.onMessage?.(msg);
      } catch {}
    };

    ws.current.onclose = () => {
      optionsRef.current.onClose?.();
      // Reconnect after 2s
      reconnectTimer.current = setTimeout(connect, 2000);
    };

    ws.current.onerror = () => {
      ws.current?.close();
    };
  }, [url]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current ?? undefined);
      ws.current?.close();
    };
  }, [connect]);

  const send = useCallback((msg: Record<string, unknown>) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(msg));
    }
  }, []);

  return { send, ws };
}
