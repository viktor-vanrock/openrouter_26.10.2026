import { useEffect } from 'react';
import { APP_NAME } from '~/utils/brand';

function useDocumentTitle(title = APP_NAME) {
  useEffect(() => {
    document.title = title;
  }, [title]);
}

export default useDocumentTitle;
