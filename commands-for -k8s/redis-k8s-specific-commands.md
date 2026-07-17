# Redis 與 K8s 分別指令

> 範圍：拆成兩段——「redis 專屬」只講 redis-cli 語法本身（假設已連上 redis，見 [redis-k8s-common-commands.md](./redis-k8s-common-commands.md)）；
> 「k8s 專屬」只講管理 redis 這個 k8s 資源的 kubectl 指令，兩段彼此不依賴對方的指令語法。

## Redis 專屬指令（redis-cli 語法，非 kubectl）

```bash
# 用密碼登入 redis，redis.yaml 有設定 requirepass，未驗證前無法執行資料操作指令
AUTH your_redis_password

# 測試連線是否存活，正常會回傳 PONG
PING

# 寫入一組 key-value 資料
SET mykey "hello"

# 讀取剛才寫入的 key 對應的值
GET mykey

# 幫 key 設定 60 秒後自動過期，時間到 redis 會自動清除該 key
EXPIRE mykey 60

# 查詢 key 剩餘存活秒數，-1 代表沒設過期時間、-2 代表 key 不存在
TTL mykey

# 列出目前資料庫中所有符合模式的 key（正式環境資料量大時會阻塞其他請求，僅建議開發環境使用）
KEYS *

# 查看 redis 伺服器資訊，包含版本、記憶體使用量、目前連線數等
INFO

# 查詢目前生效的密碼設定，用來比對 k8s Secret 裡的密碼是否真的有套用進容器
CONFIG GET requirepass

# 即時印出 redis 收到的每一個指令，用來確認 backend 是否真的有打到 redis（除錯用，正式環境會拖慢效能，用完要記得離開）
MONITOR

# 清空目前資料庫所有 key（危險指令，會清掉所有快取/session 資料，僅限開發環境手動測試使用）
FLUSHALL

# 離開 redis-cli 互動模式
EXIT
```

## K8s 專屬指令（管理 redis 這個 k8s 資源，不涉及 redis-cli 語法）

```bash
# 先套用 Secret，Deployment 啟動時會透過 secretKeyRef 讀取密碼，必須先存在
kubectl apply -f k8s/redis-secret.yaml

# 套用 redis 的 PVC、Deployment、Service 三項資源（都寫在同一份 yaml 裡）
kubectl apply -f k8s/redis.yaml

# 查看 redis Deployment 目前的期望副本數與可用副本數是否一致
kubectl get deployment redis-deploymentment

# 查看 redis pod 的詳細事件與狀態，排查 Pod 起不來、探針失敗等問題時使用
kubectl describe pod -l app=redis

# 查看 redis 掛載的 PVC 狀態，確認儲存空間是否已成功綁定（Bound）
kubectl get pvc redis-pvc

# 在不修改設定的情況下強制重建 Pod，用來套用新的 Secret 內容或排除暫時性異常
kubectl rollout restart deployment/redis-deploymentment

# 將副本數調整為 0，暫時關閉服務但保留設定與 PVC 資料（等同暫停而非刪除）
kubectl scale deployment/redis-deploymentment --replicas=0

# 刪除 redis 的 Deployment 與 Service（PVC 預設不會被刪除，之後重新 apply 資料仍會還原）
kubectl delete -f k8s/redis.yaml
```
