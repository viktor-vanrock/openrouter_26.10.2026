import { fireEvent, render, screen } from '@testing-library/react';
import StatisticsModal from './index';

const props = {
  statistics: null,
  isLoading: false,
  error: null,
  fetchStatistics: jest.fn(),
};

describe('StatisticsModal', () => {
  afterEach(() => {
    document.body.style.overflow = '';
  });

  it('does not capture Escape or lock scrolling while closed', () => {
    const onClose = jest.fn();
    render(<StatisticsModal {...props} isOpen={false} onClose={onClose} />);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText('Статистика')).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe('');
  });

  it('closes on Escape and restores scrolling after an open modal unmounts', () => {
    const onClose = jest.fn();
    const view = render(<StatisticsModal {...props} isOpen={true} onClose={onClose} />);

    expect(screen.getByText('Статистика')).toBeInTheDocument();
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(document.body.style.overflow).toBe('unset');
  });
});
