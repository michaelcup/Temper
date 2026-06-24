c=$(cat .ac 2>/dev/null || echo 5)
if [ "$c" -gt 1 ]; then echo $((c-1)) > .ac; else echo 1 > .ac; fi
i=0
while [ "$i" -lt "$c" ]; do echo "Error: required value not set"; i=$((i+1)); done
exit 1
