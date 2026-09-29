package com.softmato.hostelhub.qrscanner

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class HostelHubQrScannerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HostelHubQrScanner")

    View(QrScannerView::class) {
      Events("onCode")

      Prop("active") { view: QrScannerView, active: Boolean -> view.setActive(active) }
      Prop("torch") { view: QrScannerView, torch: Boolean -> view.setTorch(torch) }

      OnViewDestroys { view: QrScannerView -> view.release() }
    }
  }
}
