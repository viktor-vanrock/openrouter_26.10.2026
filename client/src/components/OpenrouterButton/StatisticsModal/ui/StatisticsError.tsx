interface Props {
  fetchBalance: () => void;
  error: string;
}

export const StatisticsError = ({ fetchBalance, error }: Props) => {
  return (
    <div className="flex flex-col items-center justify-center py-8">
      <div className="mb-4 text-red-500">
        <svg className="h-12 w-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      </div>
      <p className="mb-4 text-center text-red-500">{error}</p>
      <button
        onClick={() => fetchBalance()}
        className="rounded-lg bg-blue-700 px-4 py-2 text-white transition-colors hover:bg-blue-600"
      >
        Повторить попытку
      </button>
    </div>
  );
};
