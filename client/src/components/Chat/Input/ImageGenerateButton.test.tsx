import { fireEvent, render, screen } from '@testing-library/react';
import ImageGenerateButton from './ImageGenerateButton';

jest.mock('@librechat/client', () => ({ TooltipAnchor: ({ render }: { render: React.ReactNode }) => render }));

const props = { eligible: true, text: '', disabled: false, model: 'test/model', description: 'test', onGenerate: jest.fn() };

beforeEach(() => jest.clearAllMocks());

it('is disabled for empty text and while streaming', () => {
  const { rerender } = render(<ImageGenerateButton {...props} text="   " />);
  expect(screen.getByRole('button')).toBeDisabled();
  rerender(<ImageGenerateButton {...props} text="кот" disabled />);
  expect(screen.getByRole('button')).toBeDisabled();
  rerender(<ImageGenerateButton {...props} text="кот" />);
  expect(screen.getByRole('button')).toBeEnabled();
});

it('sends once on click and does not submit its form', () => {
  const onSubmit = jest.fn((event) => event.preventDefault());
  render(<form onSubmit={onSubmit}><ImageGenerateButton {...props} text="кот" /></form>);
  const button = screen.getByRole('button');
  expect(button).toHaveAttribute('type', 'button');
  fireEvent.click(button);
  expect(props.onGenerate).toHaveBeenCalledTimes(1);
  expect(onSubmit).not.toHaveBeenCalled();
});

it('is hidden when not eligible', () => {
  render(<ImageGenerateButton {...props} eligible={false} text="кот" />);
  expect(screen.queryByRole('button')).toBeNull();
});

it('does not invoke image generation when Enter is pressed in the input', () => {
  render(<form><input aria-label="Сообщение" /><ImageGenerateButton {...props} text="кот" /></form>);
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter', charCode: 13 });
  expect(props.onGenerate).not.toHaveBeenCalled();
});
