interface Props {
  title: string;
  text: string | number;
}

export const StatisticsItem = ({ title, text }: Props) => {
  return (
    <div className="rounded-lg bg-surface-chat-secondary p-4">
      <div className="flex items-center justify-between">
        <span className="font-medium text-[var(--chat-text-color)]">{title}:</span>
        <span className="text-chat-text-color text-lg font-semibold">{text}</span>
      </div>
    </div>
  );
};
