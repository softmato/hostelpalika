Pod::Spec.new do |s|
  s.name = 'ReceiptSheet'
  s.version = '1.0.0'
  s.summary = 'Standalone payment receipt sheet'
  s.description = 'Shared secure session and receipt import without launching React Native.'
  s.author = 'Softmato'
  s.homepage = 'https://hostelpalika.com'
  s.license = { :type => 'MIT' }
  s.platforms = { :ios => '16.0' }
  s.source = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = 'ReceiptCore.swift', 'ReceiptSheetModule.swift'
  s.swift_version = '5.0'
end
