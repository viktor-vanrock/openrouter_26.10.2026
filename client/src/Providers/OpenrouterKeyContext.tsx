import React, { createContext, useState, useContext, useEffect } from 'react';

interface CurrentKeyContextType {
  hasCurrentKey: boolean;
  setCurrentKey: () => void;
  isOpenDealogSetKey: boolean;
  setOpenDealogSetKey: (val: boolean) => void;
  errorOpenrouterKey?: string;
  setTextErrorOpenRouterKey: (val: string) => void;
}

const CurrentKeyContext = createContext<CurrentKeyContextType>({
  hasCurrentKey: false,
  setCurrentKey: () => {},
  isOpenDealogSetKey: false,
  setOpenDealogSetKey: () => {},
  errorOpenrouterKey: undefined,
  setTextErrorOpenRouterKey: () => {},
});

export const CurrentKeyProvider = ({ children }) => {
  const [hasCurrentKey, setHasCurrentKey] = useState(false);
  const [isOpenDealogSetKey, setIsOpenDealogSetKey] = useState(false);
  const [errorOpenrouterKey, setErrorOpenRouterKey] = useState('');

  const setCurrentKey = () => {
    setHasCurrentKey((val) => !val);
  };

  const setOpenDealogSetKey = (val: boolean) => {
    setIsOpenDealogSetKey(val);
  };

  const setTextErrorOpenRouterKey = (val: string) => {
    setErrorOpenRouterKey(val);
  };

  return (
    <CurrentKeyContext.Provider
      value={{
        hasCurrentKey,
        setCurrentKey,
        isOpenDealogSetKey,
        setOpenDealogSetKey,
        errorOpenrouterKey,
        setTextErrorOpenRouterKey,
      }}
    >
      {children}
    </CurrentKeyContext.Provider>
  );
};

export const useCurrentKey = () => {
  const context = useContext(CurrentKeyContext);
  if (!context) {
    throw new Error('useCurrentKey must be used within a CurrentKeyProvider');
  }
  return context;
};
