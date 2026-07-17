# Redis 與 K8s 共用指令

> 範圍：需要「同時用到 `kubectl` 與 `redis-cli`」的複合操作，也就是進入 k8s 叢集後才能對 redis 執行的指令組合。
> 對應資源：`k8s/redis.yaml`（Deployment/Service/PVC）、`k8s/redis-secret.yaml`（Secret）。

```bash
# 取得目前執行中的 redis pod 名稱，存成變數方便後續指令重複使用
REDIS_POD=$(kubectl get pods -l app=redis -o jsonpath='{.items[0].metadata.name}')

# 從 k8s 的 redis-secret 資源取出 base64 編碼的密碼並解碼還原成明文，用於手動連線測試
REDIS_PASSWORD=$(kubectl get secret redis-secret -o jsonpath='{.data.redis-password}' | base64 -d)

# 用 kubectl 進入 redis pod，並在裡面立刻執行 redis-cli 帶密碼登入後 PING，一行驗證「k8s 部署」與「redis 本身」是否都正常
kubectl exec -it "$REDIS_POD" -- redis-cli -a "$REDIS_PASSWORD" --no-auth-warning ping

# 進入 redis pod 並開啟 redis-cli 互動模式（不加指令直接連線），之後就能在同一個 session 下逐行輸入 redis 專屬指令
kubectl exec -it "$REDIS_POD" -- redis-cli -a "$REDIS_PASSWORD" --no-auth-warning

# 將 k8s 內 redis-service 的 6379 port 轉發到本機 6379，讓本機也能直接連線，不必每次都 kubectl exec 進容器
kubectl port-forward svc/redis-service 6379:6379

# 承上，在另一個終端機用「本機安裝的」redis-cli 連線到剛剛轉發出來的 port，效果等同於進到 pod 內執行，但指令執行地點在本機
redis-cli -h 127.0.0.1 -p 6379 -a "$REDIS_PASSWORD" --no-auth-warning ping

# 即時查看 redis pod 的容器日誌，用來確認 kubectl 部署後 redis-server 是否正常啟動、密碼參數是否被正確帶入
kubectl logs -f deployment/redis-deploymentment

# 一次確認 redis 相關的 k8s 資源都存在（Deployment、Service、PVC 沒有共用 label，需分開查）
kubectl get deployment/redis-deploymentment svc/redis-service pvc/redis-pvc secret/redis-secret
```
