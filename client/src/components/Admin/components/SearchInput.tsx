import { useState, useEffect, useRef } from 'react';
import { Search } from 'lucide-react';

interface Props {
  placeholder?: string;
  onSearch: (value: string) => void;
  debounceMs?: number;
}

export const SearchInput = ({ placeholder = 'Search...', onSearch, debounceMs = 300 }: Props) => {
  const [value, setValue] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const onSearchRef = useRef(onSearch);
  onSearchRef.current = onSearch;

  useEffect(() => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onSearchRef.current(value), debounceMs);
    return () => clearTimeout(timerRef.current);
  }, [value, debounceMs]);

  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-border-light bg-surface-secondary py-2 pl-9 pr-4 text-sm text-text-primary placeholder:text-text-secondary focus:border-blue-500 focus:outline-none"
      />
    </div>
  );
};
