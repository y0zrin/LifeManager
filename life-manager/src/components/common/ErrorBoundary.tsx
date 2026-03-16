import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  componentStack: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("ErrorBoundary caught:", error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary">
          <h2 className="error-boundary__title">表示エラーが発生しました</h2>
          <p className="error-boundary__message">
            {this.state.error?.message}
          </p>
          {this.state.componentStack && (
            <pre className="error-boundary__stack">
              {this.state.componentStack}
            </pre>
          )}
          <button
            onClick={() => this.setState({ hasError: false, error: null, componentStack: null })}
            className="btn-primary"
          >
            再試行
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
