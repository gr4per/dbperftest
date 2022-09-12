#!/usr/bin/env bash
 
set -e
 
 
 
msg=$(cat << EOF
\n
Note: you are about to log in into the k8s cluster, and are then ready\n
to connect to the DEV (and SBX) ArangoDB deployment.\n
\t Go to https://localhost:7529 in your web browser to access SBX\n
\t Go to https://localhost:8529 in your web browser to access DEV\n
\n
Plesae note that you will need to ignore the TLS warning!
\n
EOF
)
 
 
# check the prerequisites
PREREQS_FAILED=FALSE
for cmd in "az" "kubectl"; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: $cmd is not installed"
    #PREREQS_FAILED=TRUE # install on window w/ git-bash cannot enumerate an alias as cmd this way
  fi
done
 
if [ $PREREQS_FAILED = "TRUE" ]; then
  echo "Error: prerequisites not met"
  exit 1
fi
 
export ARM_SUBSCRIPTION_ID="ed1b7457-912f-4e78-8dbe-ce334eacdbfd" # CCF - ESP Kubernetes
export ARM_TENANT_ID="b914a242-e718-443b-a47c-6b4c649d8c0a" # eonos
 
export CLUSTER_RESOURCE_GROUP_NAME=K8S_WEU_DEV_3.0_2
export CLUSTER_NAME=aks-mgt-k8s-wind
 
export KUBECONFIG="$(echo ~/.kube/kubeconfig-aks-mgt-k8s-wind.yml)"
 
az account set --subscription "ed1b7457-912f-4e78-8dbe-ce334eacdbfd"
 
mkdir  -p ~/.kube
 
az aks get-credentials --resource-group "$CLUSTER_RESOURCE_GROUP_NAME" \
  --name "$CLUSTER_NAME" -f "~/.kube/kubeconfig-aks-mgt-k8s-wind.yml" --overwrite-existing
 
kubectl config set-context --current --namespace=ipeninfraproxy-dev
 
echo -e $msg
 
kubectl -n ipeninfraproxy-dev port-forward svc/arangodb-proxy-svc 7529 8529 7829 8829
 
cat << EOF
 
Connection terminated. You can re-run this script again to reconnect to the ArangoDB deployment.
 
EOF
 
