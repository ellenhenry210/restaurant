export default function Spinner() {
  return (
    <div
      className="h-10 w-10 animate-spin rounded-full border-4 border-brand-light border-t-brand"
      role="status"
      aria-label="Loading"
    />
  );
}
