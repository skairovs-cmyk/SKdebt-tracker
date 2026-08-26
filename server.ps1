$port = 8080
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")

try {
    $listener.Start()
    Write-Host "=========================================" -ForegroundColor Blue
    Write-Host "  DebtFlow Local Server is Running!      " -ForegroundColor Green
    Write-Host "  URL: http://localhost:$port/           " -ForegroundColor Cyan
    Write-Host "  Working Directory: $(Get-Location)     " -ForegroundColor DarkGray
    Write-Host "  Press [Ctrl+C] to stop the server.     " -ForegroundColor Yellow
    Write-Host "=========================================" -ForegroundColor Blue
    
    # Open the default web browser automatically
    Start-Process "http://localhost:$port/"
    
    $baseDir = Get-Location
    
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response
        
        $urlPath = $request.Url.LocalPath
        if ($urlPath -eq "/") {
            $urlPath = "/index.html"
        }
        
        # Format the file path for Windows
        $cleanPath = $urlPath.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
        $filePath = Join-Path $baseDir $cleanPath
        
        # Basic security: ensure no directory traversal out of the working folder
        $realBaseDir = [System.IO.Path]::GetFullPath($baseDir)
        $realFilePath = [System.IO.Path]::GetFullPath($filePath)
        
        if (-not $realFilePath.StartsWith($realBaseDir)) {
            $response.StatusCode = 403
            $bytes = [System.Text.Encoding]::UTF8.GetBytes("403 Forbidden: Access Denied")
            $response.ContentType = "text/plain; charset=utf-8"
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
            Write-Host "[403] Access Denied: $urlPath" -ForegroundColor DarkRed
        }
        elseif (Test-Path $filePath -PathType Leaf) {
            $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
            $mimeType = switch ($ext) {
                ".html" { "text/html; charset=utf-8" }
                ".css"  { "text/css; charset=utf-8" }
                ".js"   { "text/javascript; charset=utf-8" }
                ".json" { "application/json; charset=utf-8" }
                ".png"  { "image/png" }
                ".jpg"  { "image/jpeg" }
                ".jpeg" { "image/jpeg" }
                ".svg"  { "image/svg+xml" }
                ".ico"  { "image/x-icon" }
                default { "application/octet-stream" }
            }
            
            # Read all file contents as binary bytes to support encoding-agnostic serving
            $bytes = [System.IO.File]::ReadAllBytes($filePath)
            $response.ContentType = $mimeType
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
            Write-Host "[200] Serving: $urlPath ($mimeType)" -ForegroundColor Gray
        } else {
            $response.StatusCode = 404
            $errorMessage = "404 Not Found: $urlPath"
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($errorMessage)
            $response.ContentType = "text/plain; charset=utf-8"
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
            Write-Host "[404] Not Found: $urlPath" -ForegroundColor Red
        }
        $response.Close()
    }
} catch {
    Write-Host "Error in server: $_" -ForegroundColor Red
} finally {
    if ($listener -ne $null) {
        $listener.Stop()
        $listener.Close()
        Write-Host "Server stopped." -ForegroundColor Yellow
    }
}
