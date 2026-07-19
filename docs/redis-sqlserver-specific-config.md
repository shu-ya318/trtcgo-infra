# Redis 與 SQL Server 分別配置寫法

> 比對對象:`k8s/redis.yaml` 與 `k8s/sqlserver.yaml`。
> 範圍:兩邊各自獨有、對方沒有對應寫法的部分,分兩段列出,互不對應。

## Redis 專屬配置(redis.yaml)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis-deployment
spec:
  replicas: 1
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
    spec:
      containers:
        - name: redis
          image: docker.io/library/lookgo-redis:latest
          imagePullPolicy: IfNotPresent
          command: ['redis-server', '--requirepass', '$(REDIS_PASSWORD)']  # 覆寫容器預設啟動指令,強制 redis-server 啟動時要求密碼登入,未設定此行密碼保護不會生效
          env:
            - name: REDIS_PASSWORD               # 提供給上面 command 的 $(REDIS_PASSWORD) 變數使用
              valueFrom:
                secretKeyRef:
                  name: redis-secret               # 從 redis-secret 這個 Secret 讀值
                  key: redis-password                # 讀取其中 redis-password 這個 key
            - name: REDISCLI_AUTH                 # redis-cli 工具會自動讀這個環境變數當密碼,讓下面的 probe 不用手動帶密碼(sqlserver 沒有對應機制,probe 直接引用 $MSSQL_SA_PASSWORD)
              valueFrom:
                secretKeyRef:
                  name: redis-secret
                  key: redis-password
          livenessProbe:
            exec:
              command: ['redis-cli', '--raw', 'ping']  # 用 redis-cli 對自己 ping,測資料庫是否存活(sqlserver 沒有這種 CLI 探測方式)
```

**無持久化(與 sqlserver 最大的差異)**:redis 目前完全沒有 PVC、`volumeMounts`、`volumes` 區塊——定位是純快取,Pod 重啟後資料清空、由 backend 重新回填即可,因此不需要儲存資源。舊版曾有 `redis-pvc`,現已移除。

## SQL Server 專屬配置(sqlserver.yaml)

### 儲存:StorageClass + PVC 動態供應(redis 完全沒有這一段)

舊版手刻 `hostPath` PersistentVolume 的寫法已移除,改為「只寫 PVC、交給 StorageClass 動態供應」:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass                         # 定義一種儲存供應方式,PVC 引用它即可動態建立實體儲存,不必手刻 PV
metadata:
  name: local-path-retain
provisioner: rancher.io/local-path          # kind/k3s 常用的 local-path 動態供應器
volumeBindingMode: WaitForFirstConsumer     # 等到有 Pod 真正要用時才綁定/建立 volume,確保建在 Pod 被排程到的那個節點
reclaimPolicy: Retain                       # PVC 刪除後實體資料仍保留不清除,需人工回收(預設的 Delete 會連資料一起刪)

---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: sqlserver-pvc
spec:
  accessModes:
    - ReadWriteOnce                          # 同一時間只能被一個節點掛載讀寫,符合單一 Pod 資料庫的使用情境
  storageClassName: local-path-retain        # 指定用上面自訂的 StorageClass 動態供應
  resources:
    requests:
      storage: 2Gi                           # 跟叢集申請至少 2Gi(SQL Server 官方建議最低容量)
```

> 注意:同一個 StorageClass 目前在 `k8s/sqlserver.yaml` 開頭與獨立檔案 `k8s/local-path-retain-storageclass.yaml` **各定義了一次**(內容相同)。重複 apply 不會出錯,但屬重複定義,建議擇一保留(保留獨立檔、從 sqlserver.yaml 移除較乾淨)。

### Deployment 專屬部分

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sqlserver-deployment
spec:
  replicas: 1
  selector:
    matchLabels:
      app: sqlserver
  template:
    metadata:
      labels:
        app: sqlserver
    spec:
      securityContext:
        fsGroup: 10001                        # Pod 層級安全性設定,讓掛載進來的 volume 屬於 gid 10001,SQL Server 容器需要此群組權限才能寫入資料目錄(redis 沒有設定這個)
      containers:
        - name: sqlserver
          image: docker.io/library/lookgo-sqlserver:latest
          imagePullPolicy: IfNotPresent
          command: ['/bin/bash', '/opt/mssql-tools18/bin/init-db.sh']  # 覆寫預設啟動指令,改執行自製初始化腳本(背景啟動 sqlservr、等待就緒、跑 init.sql)
          env:
            - name: ACCEPT_EULA                # 官方映像檔要求,必須明確同意授權條款才會啟動
              value: 'Y'
            - name: MSSQL_SA_PASSWORD           # SQL Server 系統管理員密碼,給 init-db.sh 內的 sqlcmd 使用
              valueFrom:
                secretKeyRef:
                  name: sqlserver-secret
                  key: sa-password
            - name: DB_NAME                     # 給初始化腳本用來建立指定名稱的資料庫
              valueFrom:
                secretKeyRef:
                  name: sqlserver-secret
                  key: db-name
            - name: DB_USERNAME                 # 給初始化腳本用來建立應用程式專用的資料庫登入帳號
              valueFrom:
                secretKeyRef:
                  name: sqlserver-secret
                  key: db-username
            - name: DB_PASSWORD                 # 對應上面帳號的密碼
              valueFrom:
                secretKeyRef:
                  name: sqlserver-secret
                  key: db-password
          livenessProbe:
            exec:
              command:
                - /bin/bash
                - -c
                - /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$MSSQL_SA_PASSWORD" -C -Q "SELECT 1"  # 用 sqlcmd 對本機資料庫下查詢,能成功執行才算存活(redis 沒有對應的 SQL 查詢探針)
          volumeMounts:
            - name: sqlserver-data              # 對應下面 volumes 區塊同名的掛載定義(redis 已無任何 volume 掛載)
              mountPath: /var/opt/mssql          # 掛載到 SQL Server 預設的資料目錄
      volumes:
        - name: sqlserver-data                  # 這個 volume 的識別名稱,需與 volumeMounts.name 一致
          persistentVolumeClaim:
            claimName: sqlserver-pvc             # 指向前面定義的 PVC,實際儲存空間由 StorageClass 動態供應
```
