declare module 'html5-qrcode' {
  export class Html5QrcodeScanner {
    constructor(elementId: string, config?: {
      fps?: number;
      qrbox?: number;
      aspectRatio?: number;
      disableFlip?: boolean;
      memory?: boolean;
      disableContinuousScanning?: boolean;
      rememberLastUsedCamera?: boolean;
      supportedScanTypes?: number[];
      showTorchButtonIfSupported?: boolean;
      showFlipCameraButtonIfSupported?: boolean;
    });
    render(
      successCallback: (decodedText: string, decodedResult: any) => void,
      errorCallback?: (errorMessage: string) => void
    ): Promise<void>;
    clear(): Promise<void>;
  }

  export class Html5Qrcode {
    constructor(elementId: string);
    start(
      cameraId: string,
      config: { fps: number; qrbox?: number; aspectRatio?: number; disableFlip?: boolean; memory?: boolean; disableContinuousScanning?: boolean; },
      qrCodeSuccessCallback: (decodedText: string, decodedResult: any) => void,
      qrCodeErrorCallback?: (errorMessage: string) => void
    ): Promise<void>;
    stop(): Promise<void>;
    getCameraIds(): Promise<string[]>;
    applyOverlayConfig?(config: { dimWidth?: number; dimHeight?: number; borderColour?: string; borderLineWidth?: number; scannerIdleColour?: string; scannerActiveColour?: string; scannerLaserColour?: string; scannerLaserSpeed?: number; cornerColour?: string; cornerLineWidth?: number; marginColour?: string; marginLineWidth?: number; viewFinderAspectRatio?: number; }): void;
    toggleTorch?(): Promise<boolean>;
    flipCamera?(): Promise<boolean>;
  }
}
