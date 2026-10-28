param([Parameter(Mandatory=$true)][string]$ImagePath)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.FileAccessMode,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime] | Out-Null
function Await-Result($Operation,[Type]$ResultType) {
  $method=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
  $task=$method.MakeGenericMethod($ResultType).Invoke($null,@($Operation))
  return $task.GetAwaiter().GetResult()
}
$file=Await-Result ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$stream=Await-Result ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
try {
  $decoder=Await-Result ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap=Await-Result ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('zh-Hans-CN'))
  if (-not $engine) { throw 'Windows Chinese OCR language package unavailable.' }
  $result=Await-Result ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines=@(foreach($line in $result.Lines) {
     $words=@($line.Words); if ($words.Count -eq 0) { continue }
     $left=($words|ForEach-Object {$_.BoundingRect.X}|Measure-Object -Minimum).Minimum
     $top=($words|ForEach-Object {$_.BoundingRect.Y}|Measure-Object -Minimum).Minimum
     $right=($words|ForEach-Object {$_.BoundingRect.X+$_.BoundingRect.Width}|Measure-Object -Maximum).Maximum
     $bottom=($words|ForEach-Object {$_.BoundingRect.Y+$_.BoundingRect.Height}|Measure-Object -Maximum).Maximum
     @{text=$line.Text;x=[Math]::Round($left);y=[Math]::Round($top);width=[Math]::Round($right-$left);height=[Math]::Round($bottom-$top)}
  })
  @{width=$decoder.PixelWidth;height=$decoder.PixelHeight;lines=$lines} | ConvertTo-Json -Depth 6 -Compress
} finally { $stream.Dispose() }
