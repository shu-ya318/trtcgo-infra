# Backend 與 Frontend 分別指令

> 範圍：backend（Spring Boot / Maven）與 frontend（Nginx / npm）技術棧不同，這裡列出兩邊「不通用」、
> 各自技術棧才有意義的指令，分兩段列出、互不對應。

## Backend 專屬指令

```bash
# 建置 backend 映像檔時帶入自訂 Maven 設定檔，對應 lookGo-backend Dockerfile 的 SETTINGS_FILE build arg（frontend 沒有這個參數）
docker build --build-arg SETTINGS_FILE=settings-nexus.xml -t lookgo-backend:latest ../lookGo-backend

# 呼叫 Spring Boot Actuator 健康檢查端點，會聚合 DB、Redis 等依賴的連線狀態（frontend 沒有 actuator）
curl http://localhost:8080/actuator/health

# 查看 backend pod 內目前生效的環境變數，確認 SPRING_PROFILES_ACTIVE、DB_HOST、JWT 等設定是否正確套用
kubectl exec -it deployment/backend-deployment -- env | grep -E 'SPRING|DB_|REDIS_|JWT_'

# 解碼 backend-secret 內的 TDX 用戶端密鑰，確認第三方 API 憑證是否正確設定（此 Secret 只有 backend 會用到）
kubectl get secret backend-secret -o jsonpath='{.data.tdx-client-id}' | base64 -d

# 查看 backend pod 的即時 CPU / 記憶體使用量，JVM 應用通常比 nginx 吃更多記憶體，需另外關注（需先安裝 metrics-server）
kubectl top pod -l app=backend
```

## Frontend 專屬指令

```bash
# 建置 frontend 映像檔時帶入自訂 npm 設定檔，對應 lookGo-frontend Dockerfile 的 NPM_RC_FILE build arg（backend 沒有這個參數）
docker build --build-arg NPM_RC_FILE=.npmrc-nexus -t lookgo-frontend:latest ../lookGo-frontend

# 檢查 frontend 容器內 nginx 設定檔語法是否正確，避免設定寫錯導致 nginx 啟動失敗（backend 沒有 nginx）
kubectl exec -it deployment/frontend-deployment -- nginx -t

# 查看 frontend 容器內實際生效的 nginx 設定內容，確認 BACKEND_URL 等環境變數有正確套用進設定檔
kubectl exec -it deployment/frontend-deployment -- cat /etc/nginx/conf.d/default.conf

# 直接呼叫 frontend 首頁，確認 nginx 是否正常回應（frontend 專屬健康檢查方式，端點與 backend 的 actuator 不同）
curl -sf http://localhost:8081/

# 重新載入 nginx 設定而不中斷現有連線，設定變更後想避免整個 Pod 重啟時使用
kubectl exec -it deployment/frontend-deployment -- nginx -s reload
```
