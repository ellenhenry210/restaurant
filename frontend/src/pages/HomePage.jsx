// Not a real "home page" in the delivery-app sense — SnapOrder has no
// entry point other than scanning a table's physical QR code (see
// product-vision.md: "NOT a delivery app"). This exists only so `/`
// (reached by mistake, or a QR link without its ?code= for some reason)
// tells the guest what to actually do, instead of a blank page or a 404.
export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-md py-2xl text-center">
      <div className="max-w-sm">
        <h1 className="text-[24px] font-semibold leading-[1.33] tracking-[-0.25px] text-ink">SnapOrder</h1>
        <p className="mt-sm text-sm text-ink-secondary">
          Scan the QR code on your table to view the menu and place your order.
        </p>
      </div>
    </main>
  );
}
